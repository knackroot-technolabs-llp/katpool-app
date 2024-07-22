import dotenv from 'dotenv';
import { serve } from 'bun';
import { register } from '../prometheus';
import config from '../../config.json';

dotenv.config();

class ApiService {
  constructor(private port: number) {}

  start() {
    serve({
      port: this.port,
      async fetch(req) {
        const url = new URL(req.url, `http://${req.headers.get('host')}`);
        if (url.pathname === '/metrics') {
          const metrics = await register.metrics();
          return new Response(metrics, {
            headers: { 'Content-Type': register.contentType },
          });
        } else if (url.pathname === '/config') {
          return new Response(JSON.stringify(config), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }
    });
  }
}

export default ApiService;
