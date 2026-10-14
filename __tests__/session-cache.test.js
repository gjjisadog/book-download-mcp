import { test, expect, afterEach, jest } from '@jest/globals';
import { sessionEnvironment, acceptSessionResponse, clearSessions } from '../lib/session-cache.js';
const env = { ZLIBRARY_EMAIL: 'test', ZLIBRARY_PASSWORD: 'private', ZLIBRARY_EAPI_DOMAIN: 'example.org' };
afterEach(() => { clearSessions(); jest.useRealTimers(); });
test('reuses private sessions and strips them from public output', () => {
  sessionEnvironment(env);
  const data = { expires: Date.now() / 1000 + 590, domain: 'example.org', userid: 'id', userkey: 'private-token' };
  const response = acceptSessionResponse(JSON.stringify({ content: [], session_cache: { a: data } }), env);
  expect(JSON.parse(response)).toEqual({ content: [] });
  expect(JSON.parse(sessionEnvironment(env).ZLIBRARY_SESSION_CACHE)).toEqual({ a: data });
  expect(JSON.parse(sessionEnvironment({ ...env, ZLIBRARY_PASSWORD: 'changed' }).ZLIBRARY_SESSION_CACHE)).toEqual({});
});
test('rejects expired, malformed, overlong sessions and late responses for old credentials', () => {
  sessionEnvironment(env);
  acceptSessionResponse(JSON.stringify({ session_cache: { expired: { expires: 0 }, overlong: { expires: Date.now() / 1000 + 10000 }, bad: null } }), env);
  expect(JSON.parse(sessionEnvironment(env).ZLIBRARY_SESSION_CACHE)).toEqual({});
  sessionEnvironment({ ...env, ZLIBRARY_PASSWORD: 'new' });
  acceptSessionResponse(JSON.stringify({ session_cache: { a: { expires: Date.now() / 1000 + 100, domain: 'example.org', userid: 'id', userkey: 'key' } } }), env);
  expect(JSON.parse(sessionEnvironment({ ...env, ZLIBRARY_PASSWORD: 'new' }).ZLIBRARY_SESSION_CACHE)).toEqual({});
});
test('removes sessions at TTL expiry', () => {
  jest.useFakeTimers(); sessionEnvironment(env);
  acceptSessionResponse(JSON.stringify({ session_cache: { a: { expires: Date.now() / 1000 + 1, domain: 'example.org', userid: 'id', userkey: 'key' } } }), env);
  jest.advanceTimersByTime(2000);
  expect(JSON.parse(sessionEnvironment(env).ZLIBRARY_SESSION_CACHE)).toEqual({});
});
