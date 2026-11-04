// Forward kinematics of the G1 MJCF tree exported by tools/export_g1.py (MuJoCo conventions:
// quaternions are [w, x, y, z]; a hinge rotates its body about `axis` through `anchor`, both in the body frame;
// a free joint places the body at qpos[0:3] with orientation qpos[3:7]).
// Pure functions, shared by the page and tools/fk_check.mjs.

export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function qrot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function normalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// qpos: [x, y, z, qw, qx, qy, qz, 29 hinge angles]; returns per-body world {pos, quat}.
export function forwardKinematics(tree, qpos) {
  const out = new Array(tree.bodies.length);
  tree.bodies.forEach((b, i) => {
    let pos, quat;
    const j = b.joint;
    if (j && j.free) {
      pos = [qpos[j.qpos], qpos[j.qpos + 1], qpos[j.qpos + 2]];
      quat = normalize([qpos[j.qpos + 3], qpos[j.qpos + 4], qpos[j.qpos + 5], qpos[j.qpos + 6]]);
    } else {
      let lp = b.pos, lq = b.quat;
      if (j) {
        const h = qpos[j.qpos] / 2, s = Math.sin(h);
        const r = [Math.cos(h), j.axis[0] * s, j.axis[1] * s, j.axis[2] * s];
        const ra = qrot(r, j.anchor);
        const shift = qrot(lq, [j.anchor[0] - ra[0], j.anchor[1] - ra[1], j.anchor[2] - ra[2]]);
        lp = [lp[0] + shift[0], lp[1] + shift[1], lp[2] + shift[2]];
        lq = qmul(lq, r);
      }
      if (b.parent < 0) {
        pos = lp; quat = lq;
      } else {
        const p = out[b.parent];
        const t = qrot(p.quat, lp);
        pos = [p.pos[0] + t[0], p.pos[1] + t[1], p.pos[2] + t[2]];
        quat = qmul(p.quat, lq);
      }
    }
    out[i] = { pos, quat };
  });
  return out;
}
