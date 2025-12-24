import http from 'k6/http';
import { check, sleep } from 'k6';

// 1. CONFIGURATION
export const options = {
  stages: [
    { duration: '5s', target: 20 },  // Warm up
    { duration: '20s', target: 50 }, // 💥 HAMMER TIME (50 Users)
    { duration: '5s', target: 0 },   // Cool down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],   // Error rate < 1%
    http_req_duration: ['p(95)<200'], // 95% requests < 200ms
  },
};

// Helper function to replace k6/utils
function randomIntBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

export default function () {
  // Use host.docker.internal for Windows Docker
  const url = 'http://host.docker.internal:3000/api/events'; 

  // 2. RANDOMIZED CHAOS
  const rand = randomIntBetween(1, 100);
  let targetUrl = 'https://httpbin.org/status/200'; // Default: Success
  let type = 'Success';

  if (rand > 70 && rand <= 85) {
    targetUrl = 'https://httpbin.org/status/404'; // Permanent Fail
    type = 'Client Error';
  } else if (rand > 85 && rand <= 95) {
    targetUrl = 'https://httpbin.org/status/500'; // Retry Bait
    type = 'Server Crash';
  } else if (rand > 95) {
    targetUrl = 'https://httpbin.org/status/429'; // Throttling
    type = 'Rate Limited';
  }

  const payload = JSON.stringify({
    url: targetUrl,
    payload: { 
        msg: "Stress Test", 
        type: type,
        vu: __VU, 
        iter: __ITER 
    }
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'architect-secret-123',
    },
  };

  const res = http.post(url, payload, params);

  check(res, {
    'status is 202': (r) => r.status === 202, 
  });

  sleep(0.1); 
}