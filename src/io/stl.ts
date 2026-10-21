/**
 * Leitura de STL (binário ou ASCII).
 *
 * Um STL contém SOMENTE geometria. Daqui se extrai: número de triângulos,
 * dimensões (caixa delimitadora) e volume do sólido. Peso real, tempo de
 * impressão, material e cor dependem de fatiamento — não são inferidos.
 */
export interface StlInfo {
  format: 'binário' | 'ASCII';
  triangles: number;
  sizeMm: { x: number; y: number; z: number };
  /** Volume do sólido fechado (cm³). Malhas abertas produzem valor não confiável. */
  volumeCm3: number;
  surfaceCm2: number;
}

function signedVolume(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

function area(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

export function parseStl(buffer: ArrayBuffer): StlInfo {
  const view = new DataView(buffer);
  const isBinary = buffer.byteLength >= 84 && 84 + view.getUint32(80, true) * 50 === buffer.byteLength;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vol = 0, surf = 0, tris = 0;
  const handle = (v: number[]) => {
    for (let i = 0; i < 9; i++) { const k = i % 3; if (v[i] < min[k]) min[k] = v[i]; if (v[i] > max[k]) max[k] = v[i]; }
    vol += signedVolume(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
    surf += area(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
    tris++;
  };
  if (isBinary) {
    const n = view.getUint32(80, true);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      const v: number[] = [];
      for (let i = 0; i < 9; i++) v.push(view.getFloat32(o + i * 4, true));
      handle(v);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    if (!/^\s*solid/i.test(text)) throw new Error('Arquivo não reconhecido como STL.');
    const re = /vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g;
    let m: RegExpExecArray | null;
    let acc: number[] = [];
    while ((m = re.exec(text))) {
      acc.push(+m[1], +m[2], +m[3]);
      if (acc.length === 9) { handle(acc); acc = []; }
    }
  }
  if (tris === 0) throw new Error('Nenhum triângulo encontrado no STL.');
  return {
    format: isBinary ? 'binário' : 'ASCII', triangles: tris,
    sizeMm: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    volumeCm3: Math.abs(vol) / 1000, surfaceCm2: surf / 100,
  };
}
