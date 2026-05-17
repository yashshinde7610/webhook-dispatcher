    // XSS protection
    const escapeHTML = (str) => String(str).replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])
    );

    // Dashboard auth (URL -> localStorage, strip from history)
    const tokenFromUrl = new URLSearchParams(window.location.search).get('token');
    if (tokenFromUrl) {
        localStorage.setItem('dashboardToken', tokenFromUrl);
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('token');
        window.history.replaceState({}, '', cleanUrl.toString());
    }
    const dashboardToken = tokenFromUrl
        || localStorage.getItem('dashboardToken')
        || prompt('Enter Dashboard Token:');
    if (dashboardToken) localStorage.setItem('dashboardToken', dashboardToken);

    // Socket.IO
    const socket = io({ auth: { token: dashboardToken } });

    const eventsContainer = document.getElementById('events');
    const connStatus      = document.getElementById('connection-status');
    const emptyState      = document.getElementById('empty-state');
    const eventCountEl    = document.getElementById('event-count');
    let   eventCount      = 0;

    // Cached API key (prompted once per session, reused for subsequent calls)
    let cachedApiKey = null;
    function getApiKey() {
        if (cachedApiKey) return cachedApiKey;
        const key = prompt('Enter API Key to authorize this action:');
        if (key) cachedApiKey = key;
        return key;
    }

    socket.on('connect', () => {
        connStatus.innerHTML = '<span class="live-wrap"><span class="live-ring"></span><span class="live-core"></span></span><span class="text-emerald-500 font-semibold ml-1">Live</span>';
    });

    socket.on('disconnect', () => {
        connStatus.innerHTML = '<span class="offline-dot"></span><span class="ml-1.5">Disconnected</span>';
    });

    // Metrics
    socket.on('dashboard-stats', (stats) => {
        document.getElementById('count-active').innerText  = stats.active;
        document.getElementById('count-waiting').innerText = stats.waiting;
        document.getElementById('count-failed').innerText  = stats.failed;
        const redisEl = document.getElementById('redis-status');
        const isReady = stats.redisStatus === 'ready';
        redisEl.innerText = stats.redisStatus.toUpperCase();
        redisEl.className = isReady ? 'stat-num text-emerald-400' : 'stat-num text-rose-400';
        redisEl.style.cssText = "font-size:1.4rem;font-family:'JetBrains Mono',monospace;";
    });

    // Status styling
    function getStatusConfig(rawStatus) {
        const s = rawStatus?.toLowerCase?.() || '';
        if (s.includes('completed'))
            return { cardClass: 'card-completed', badgeClass: 'badge badge-completed' };
        if (s.includes('pending') || s.includes('active'))
            return { cardClass: 'card-pending',   badgeClass: 'badge badge-pending'   };
        if (s.includes('dead'))
            return { cardClass: 'card-dead',      badgeClass: 'badge badge-dead'      };
        if (s.includes('failed') || s.includes('aborted') || s.includes('permanent'))
            return { cardClass: 'card-failed',    badgeClass: 'badge badge-failed'    };
        return { cardClass: 'card-default', badgeClass: 'badge badge-default' };
    }

    // Render a job card
    window.renderJobUpdate = function renderJobUpdate(job) {
        if (emptyState && emptyState.parentNode) emptyState.remove();

        let card    = document.getElementById(`card-${job.id}`);
        const isNew = !card;

        if (isNew) {
            card    = document.createElement('div');
            card.id = `card-${job.id}`;
            eventsContainer.prepend(card);
            eventCount++;
            eventCountEl.textContent = `${eventCount} event${eventCount !== 1 ? 's' : ''}`;
        }

        const cfg  = getStatusConfig(job.status);
        const time = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const dataPreview = typeof job.response === 'object'
            ? JSON.stringify(job.response, null, 2)
            : job.response;

        const showReplay = job.status !== 'Pending' && job.status !== 'active';
        const replayBtn  = showReplay ? `
            <button class="card-btn" onclick="replayJob('${job.id}')">
                <svg style="width:12px;height:12px;flex-shrink:0;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
                Replay Job
            </button>` : '';

        card.className = `event-card ${cfg.cardClass}`;
        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <code style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:#71717a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                      title="${escapeHTML(String(job.id))}">
                    ${escapeHTML(String(job.id).slice(-12))}
                </code>
                <span class="${cfg.badgeClass}">
                    <span class="badge-dot"></span>
                    ${escapeHTML(job.status)}
                </span>
            </div>
            <p style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:#3f3f46;margin-top:6px;">${time}</p>
            <pre class="json-block">${escapeHTML(dataPreview || 'Processing...')}</pre>
            ${replayBtn}
        `;
    }

    // Batched updates
    socket.on('job-update-batch', (batch) => {
        if (!Array.isArray(batch)) return;
        batch.forEach(window.renderJobUpdate);
        while (eventsContainer.children.length > 50) {
            eventsContainer.lastChild.remove();
        }
    });

    // Backward-compat
    socket.on('job-update', window.renderJobUpdate);

    // Load historical failed/dead events from MongoDB
    window.loadFailedEvents = async function loadFailedEvents() {
        const apiKey = getApiKey();
        if (!apiKey) return;

        const btn = document.getElementById('load-failed-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Loading...';

        try {
            const statuses = ['FAILED', 'FAILED_PERMANENT', 'DEAD'];
            let loaded = 0;
            for (const status of statuses) {
                const res = await fetch(`/api/events?status=${status}&limit=20`, {
                    headers: { 'x-api-key': apiKey }
                });
                if (!res.ok) continue;
                const data = await res.json();
                for (const evt of data.events) {
                    // Map MongoDB event to the renderJobUpdate format
                    window.renderJobUpdate({
                        id: evt._id,
                        status: evt.status,
                        response: evt.lastError || evt.payload || 'No details',
                        timestamp: evt.updatedAt || evt.createdAt
                    });
                    loaded++;
                }
            }
            if (loaded === 0) alert('No failed/dead events found in the database.');
        } catch (err) {
            alert('Failed to load events: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg style="width:12px;height:12px;flex-shrink:0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Load Failed Events';
        }
    }

    // Replay
    window.replayJob = async function replayJob(id) {
        try {
            const apiKey = getApiKey();
            if (!apiKey) return;

            const btn = document.querySelector(`#card-${id} .card-btn`);
            if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Queuing...'; }

            const res  = await fetch(`/api/events/${id}/replay`, {
                method: 'POST',
                headers: { 'x-api-key': apiKey }
            });
            const data = await res.json();
            if (!res.ok) alert('Error: ' + data.error);
        } catch (err) {
            alert('Failed to replay: ' + err.message);
        }
    }
