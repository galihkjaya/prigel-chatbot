import { handleApi } from '../../api.js';

export default function handler(request) {
  // Lambda encodes binary requests, so stay under Netlify's payload limit.
  return handleApi(request, 4 * 1024 ** 2);
}

export const config = {
  path: ['/api/chat', '/api/resources'],
};
