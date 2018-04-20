import { parseQuery } from '../url';

const query = parseQuery(window.location.search || '');
window.location.href = query.logout_uri;
