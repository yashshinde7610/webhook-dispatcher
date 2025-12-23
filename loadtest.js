import http from 'k6/http';
import { check, sleep } from 'k6';

// 1. CONFIGURATION
export const options = {
  vus: 10,           // 10 Virtual Users running in parallel
  duration: '30s',   // Run for 30 seconds
};

export default function () {
  // 2. THE TARGET
  // Note: If running k6 via Docker on Windows, use 'host.docker.internal' to reach your PC
  // If running k6 locally, change this to 'http://localhost:3000/api/events'
  const url = 'http://host.docker.internal:3000/api/events'; 

  const payload = JSON.stringify({
    url: "https://httpbin.org/post", // Safe target that accepts POST
    payload: { 
        msg: "Load Test", 
        timestamp: new Date().toISOString() 
    }
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'architect-secret-123',
    },
  };

  // 3. THE ATTACK
  const res = http.post(url, payload, params);

  // 4. THE VERDICT
  check(res, {
    'status is 202': (r) => r.status === 202, // Did the API accept it?
  });

  sleep(0.5); // Wait 0.5s before hitting it again
}