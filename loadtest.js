import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    quick_test: {
      executor: 'shared-iterations', 
      
      // 50 users is plenty fast for a 5k run (keeps memory stable)
      // You can bump this to 100 if your Mock Server is very fast
      vus: 50,             
      
      // STOP exactly after 5000 requests
      iterations: 5000,     
      
      // If it takes longer than 1m, something is wrong
      maxDuration: '1m',    
    },
  },
};

export default function () {
  // 1. The Entry Point (Your API)
  const url = 'http://host.docker.internal:3000/api/events'; 
  
  // 2. The Target (Where the Worker sends data)
  // This points to your laptop's Port 8000 (Node Mock or Docker container)
  const targetUrl = 'http://speed-target:8080/';

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