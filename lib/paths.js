export function normalize(p) {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function scopeDir(pattern) {
  const segs = normalize(pattern).split('/');
  const firstWild = segs.findIndex((s) => /[*?]/.test(s));
  if (firstWild === -1) return segs.slice(0, -1).join('/') || '.';
  return segs.slice(0, firstWild).join('/') || '.';
}

export function isAncestor(dir, path) {
  const d = normalize(dir), p = normalize(path);
  if (d === '.') return true;
  return p === d || p.startsWith(d + '/');
}

export function setsOverlap(dirsA, dirsB) {
  const hits = [];
  for (const a of dirsA) for (const b of dirsB) {
    if (isAncestor(a, b) || isAncestor(b, a)) hits.push(`${a} <-> ${b}`);
  }
  return hits.length ? hits : null;
}

export function ownsFile(dirs, file) {
  return dirs.some((d) => isAncestor(d, file));
}
