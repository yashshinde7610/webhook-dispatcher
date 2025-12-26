import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    quick_test: {
      executor: 'shared-iterations', 
      
      // 100 users working together to hit 5,000 total requests
      vus: 100,             
      iterations: 5000,     
      maxDuration: '30s',   // Safety timeout
    },
  },
};

export default function () {
  const url = 'http://host.docker.internal:3000/api/events'; 
  
  // Use your local Node mock server (Port 8000) for best speed
  const targetUrl = 'http://host.docker.internal:8000/webhook';

  const payload = JSON.stringify({
    url: targetUrl,
    payload: { msg: "5k Speed Run", type: "Success" }
  });

  const params = {
    headers: { 
        'Content-Type': 'application/json', 
        'x-api-key': 'architect-secret-123' 
    },
  };

  http.post(url, payload, params);
}