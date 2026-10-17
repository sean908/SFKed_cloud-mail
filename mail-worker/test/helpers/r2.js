export function makeR2({ failPutAt, failDelete = false } = {}) {
	const objects = new Map();
	let putCount = 0;

	const r2 = {
		async put(key, content, options = {}) {
			putCount++;
			if (failPutAt === putCount) {
				throw new Error('forced R2 put failure');
			}
			const bytes = new Uint8Array(content);
			objects.set(key, { bytes, options });
		},
		async get(key) {
			const object = objects.get(key);
			if (!object) return null;
			return {
				async arrayBuffer() {
					return object.bytes.buffer.slice(
						object.bytes.byteOffset,
						object.bytes.byteOffset + object.bytes.byteLength
					);
				},
			};
		},
		async delete(key) {
			if (failDelete) {
				throw new Error('forced R2 delete failure');
			}
			if (Array.isArray(key)) {
				key.forEach(item => objects.delete(item));
			} else {
				objects.delete(key);
			}
		},
	};

	return { r2, objects };
}
