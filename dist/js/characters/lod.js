// Level of detail for skinned meshes by vertex clustering: vertices that fall
// in the same grid cell (character space, rest pose) merge into one, and
// triangles that collapse are dropped. Skin weights, normals and UVs come
// from each cell's representative vertex, so the result still skins on the
// same skeleton. Pure array code, unit-tested in Node.

// positions: flat xyz (character space); cell: grid size in the same units.
// Returns {rep: Int32Array (old vertex -> new vertex), source: Uint32Array
// (new vertex -> old vertex)}.
export function clusterVertices(positions, cell) {
  const count = positions.length / 3;
  const cellOf = new Map();
  const rep = new Int32Array(count);
  const source = [];
  const inv = 1 / cell;
  for (let v = 0; v < count; v++) {
    const key = `${Math.floor(positions[v * 3] * inv)},${Math.floor(positions[v * 3 + 1] * inv)},${Math.floor(positions[v * 3 + 2] * inv)}`;
    let r = cellOf.get(key);
    if (r === undefined) { r = source.length; source.push(v); cellOf.set(key, r); }
    rep[v] = r;
  }
  return { rep, source: Uint32Array.from(source) };
}

// Remaps triangles [start, start + count) of an index list through `rep`,
// dropping collapsed and duplicated triangles. Returns a plain array.
export function remapTriangles(index, rep, start = 0, count = index.length - start) {
  const out = [];
  const seen = new Set();
  const end = Math.min(index.length, start + count);
  for (let t = start; t + 2 < end; t += 3) {
    const a = rep[index[t]], b = rep[index[t + 1]], c = rep[index[t + 2]];
    if (a === b || b === c || a === c) continue;
    // Rotate so the smallest index leads: same triangle, same winding, same key.
    const key = a < b && a < c ? `${a},${b},${c}` : b < c ? `${b},${c},${a}` : `${c},${a},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a, b, c);
  }
  return out;
}

// Copies per-vertex values (itemSize components) for the kept vertices.
export function gather(array, itemSize, source, stride = itemSize, offset = 0) {
  const out = new array.constructor(source.length * itemSize);
  for (let i = 0; i < source.length; i++) {
    const from = source[i] * stride + offset;
    for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = array[from + k];
  }
  return out;
}
