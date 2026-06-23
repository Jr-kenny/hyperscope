// Standard response envelope shared by every endpoint, so an agent always gets
// the same shape back: version, which service answered, what it asked, and data.

export const VERSION = "0.1.0";

export function ok(service: string, request: unknown, data: unknown) {
  return { version: VERSION, service, request, data };
}

export function fail(service: string, error: string, request?: unknown) {
  return { version: VERSION, service, request: request ?? null, error };
}
