import { env } from 'cloudflare:test';
import { dbInit } from '../../src/init/init';

// Build the full D1 schema by replaying the same migrations the worker
// runs on /init/:secret. Returns a minimal Hono-like context.
export function makeContext(overrides = {}) {
	return {
		env,
		req: {
			param: () => env.jwt_secret,
			header: () => undefined,
			raw: {},
		},
		set: () => {},
		get: () => undefined,
		text: (body, status) => new Response(body, { status: status || 200 }),
		...overrides,
	};
}

export async function setupSchema(c = makeContext()) {
	await dbInit.intDB(c);
	await dbInit.v1_1DB(c);
	await dbInit.v1_2DB(c);
	await dbInit.v1_3DB(c);
	await dbInit.v1_3_1DB(c);
	await dbInit.v1_4DB(c);
	await dbInit.v1_5DB(c);
	await dbInit.v1_6DB(c);
	await dbInit.v1_7DB(c);
	await dbInit.v2DB(c);
	await dbInit.v2_3DB(c);
	await dbInit.v2_4DB(c);
	await dbInit.v2_5DB(c);
	await dbInit.v2_6DB(c);
	await dbInit.v2_7DB(c);
	await dbInit.v2_8DB(c);
	await dbInit.v2_9DB(c);
	await dbInit.v3_0DB(c);
	await dbInit.v3_1DB(c);
	await dbInit.v3_2DB(c);
	await dbInit.v3_3DB(c);
	await dbInit.v3_4DB(c);
	await dbInit.v3_5DB(c);
	return c;
}
