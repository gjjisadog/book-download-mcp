import { createHash } from 'crypto';
let identity = '';
let sessions: Record<string, any> = {};
function fingerprint(env: NodeJS.ProcessEnv): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        env.ZLIBRARY_ACCOUNTS,
        env.ZLIBRARY_EMAIL,
        env.ZLIBRARY_PASSWORD,
        env.ZLIBRARY_EAPI_DOMAIN,
      ]),
    )
    .digest('hex');
}
export function sessionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = fingerprint(env);
  if (next !== identity) {
    identity = next;
    sessions = {};
  }
  const now = Date.now() / 1000;
  sessions = Object.fromEntries(
    Object.entries(sessions).filter(([, value]) => value.expires > now),
  );
  return { ...env, ZLIBRARY_SESSION_CACHE: JSON.stringify(sessions) };
}
export function acceptSessionResponse(stdout: string, env: NodeJS.ProcessEnv): string {
  const response = JSON.parse(stdout);
  if (response.session_cache && typeof response.session_cache === 'object') {
    if (fingerprint(env) === identity) {
      const now = Date.now() / 1000;
      for (const [key, value] of Object.entries(response.session_cache)) {
        const data = value as any;
        if (
          data &&
          typeof data.expires === 'number' &&
          data.expires > now &&
          data.expires <= now + 600 &&
          ['domain', 'userid', 'userkey'].every(
            (field) => typeof data[field] === 'string' && data[field],
          )
        ) {
          sessions[key] = data;
        }
      }
    }
    delete response.session_cache;
  }
  return JSON.stringify(response);
}
export function clearSessions(): void {
  sessions = {};
}
