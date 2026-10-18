"""
Bake the sculpted octopus for Driftform's WebGL contour renderer (ADR 0003).

Run with Blender (5.x), against the art-directed .blend:

    blender --background path/to/octopus-clean.blend \
        --python tools/bake_octopus.py -- src/characters/octopus

Writes `<out>.json` (skeleton + layout) and `<out>.bin` (mesh + per-vertex data).

Per vertex:
- position, quantized to int16 within the mesh's bounding box
- skinning: the nearest point on the one or two closest skeleton chains
  (node a, node b, t along that segment), blended by weight w, so the web
  stretches smoothly between arms as they move
- flow coordinate: how far along its chain from the arm crown, in units of
  "one ring". Spacing follows the body's thickness, so thin arm tips get
  proportionally more rings and stay solid. Rings are drawn where it
  crosses whole numbers.
- eye coordinates: 2D position on the nearest eye turret's plane (or far
  away when not near an eye), for concentric eye rings and a slit pupil.

What it expects inside the .blend:
- `octopus_clean`: the approved, decimated, watertight sculpt.
- `octopus_body`:  head + mantle alone, used to find the body's centerline.
- text block `df_arms.py`: the arm generator (`centerline()`, `ARMS`, `radius()`, crown `CX, CY, CZ`).
"""

import json
import math
import struct
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "octopus"

BODY_NODES = 10
ARM_NODES = 14
BODY_SPACING = 0.016       # world distance between rings on the body
ARM_SPACING_MAX = 0.02     # rings on an arm: this far apart at the thick root...
ARM_SPACING_K = 0.45       # ...or this fraction of the arm's radius, whichever is closer
ARM_SPACING_MIN = 0.006    # but never closer than this at the very tip
DIR_SMOOTH = 80            # smoothing passes on the graph distance before taking its directions
BLEND = 0.04               # width of the zone where a vertex is shared by two chains
# Eye turrets, found by raycasting the approved sculpt from a top view through
# the two visible bulges (Blender coords: surface hit point, outward normal).
EYES = [
    dict(hit=(-0.1228, 0.0, 0.4282), normal=(-0.272, -0.34, 0.9)),
    dict(hit=(0.0929, 0.0037, 0.4228), normal=(0.192, -0.509, 0.839)),
]
EYE_RADIUS = 0.07          # eye coordinates are stored out to this distance from the apex


# ---------------------------------------------------------------- helpers

def mesh_arrays(name):
    ob = bpy.data.objects[name]
    me = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    me.calc_loop_triangles()
    verts = np.array([ob.matrix_world @ v.co for v in me.vertices], dtype=np.float64)
    tris = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
    return verts, tris


def arclength(points):
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    return np.concatenate([[0], np.cumsum(seg)])


def sample_polyline(points, u):
    s = arclength(points)
    s = s / s[-1]
    return np.stack([np.interp(u, s, points[:, k]) for k in range(3)], axis=-1)


def slice_centroid(verts, tris, origin, normal):
    """Centroid of the plane's cut through the mesh nearest `origin` (rough, for the centerline)."""
    d = (verts - origin) @ normal
    s = d[tris] > 0
    crossing = tris[(s.any(axis=1)) & (~s.all(axis=1))]
    if len(crossing) == 0:
        return None
    pts = []
    for tri in crossing:
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if (d[a] > 0) != (d[b] > 0):
                t = d[a] / (d[a] - d[b])
                pts.append(verts[a] + (verts[b] - verts[a]) * t)
    pts = np.array(pts)
    # Keep the cluster around the origin (the nearest connected-ish blob).
    dist = np.linalg.norm(pts - origin, axis=1)
    near = pts[dist < np.percentile(dist, 60) * 1.5]
    return near.mean(axis=0)


def body_centerline(bverts, btris, crown):
    """Head + mantle axis through slice centroids, then bent down through the head to the crown."""
    mean = bverts.mean(axis=0)
    _, _, vt = np.linalg.svd(bverts - mean, full_matrices=False)
    axis = vt[0] if vt[0][1] > 0 else -vt[0]
    proj = (bverts - mean) @ axis
    lo, hi = proj.min(), proj.max()
    ts = np.linspace(lo + 0.02 * (hi - lo), hi - 0.02 * (hi - lo), 40)
    cents = []
    for t in ts:
        c = slice_centroid(bverts, btris, mean + axis * t, axis)
        cents.append(c if c is not None else mean + axis * t)
    cents = np.array(cents)
    k = np.ones(5) / 5
    line = np.stack([np.convolve(np.pad(cents[:, j], 2, mode="edge"), k, mode="valid") for j in range(3)], axis=1)
    # Bend: leave the crown straight up, join the mantle axis past the head.
    j = int(np.argmin(np.linalg.norm(line[:, :2] - crown[:2], axis=1)))
    head = line[j]
    j2 = min(j + 4, len(line) - 2)
    out_dir = line[j2 + 1] - line[j2]
    out_dir /= np.linalg.norm(out_dir)
    p0, p3 = crown, line[j2]
    p1 = crown + np.array([0, 0, (head[2] - crown[2]) * 0.9])
    p2 = p3 - out_dir * np.linalg.norm(p3 - head) * 0.8
    tt = np.linspace(0, 1, 24)[:, None]
    bez = (1 - tt) ** 3 * p0 + 3 * (1 - tt) ** 2 * tt * p1 + 3 * (1 - tt) * tt ** 2 * p2 + tt ** 3 * p3
    tail = line[-1] + (line[-1] - line[-2]) / np.linalg.norm(line[-1] - line[-2]) * 0.02
    return np.vstack([bez, line[j2 + 1:], tail])


def closest_on_polyline(p, nodes):
    """Closest point on a node polyline: (distance, segment index, t)."""
    a = nodes[:-1]
    ab = nodes[1:] - a
    t = np.clip(np.einsum("ij,ij->i", p - a, ab) / np.maximum(np.einsum("ij,ij->i", ab, ab), 1e-12), 0, 1)
    q = a + ab * t[:, None]
    d = np.linalg.norm(q - p, axis=1)
    i = int(np.argmin(d))
    return float(d[i]), i, float(t[i])


def to_engine(v):
    """Blender (x, y, z) Z-up → engine (x, z, -y) Y-up, +z toward the viewer."""
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)



def cotan_laplacian(verts, tris):
    """Cotangent weights as directed edge arrays (I, J, W) plus lumped vertex areas."""
    I, J, W = [], [], []
    area = np.zeros(len(verts))
    for tri in tris:
        p = verts[tri]
        a2 = np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0]))
        area[tri] += a2 / 6
        for k in range(3):
            i, j, o = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
            a, b = verts[i] - verts[o], verts[j] - verts[o]
            cot = float(a @ b) / max(float(np.linalg.norm(np.cross(a, b))), 1e-12)
            I += [i, j]; J += [j, i]; W += [0.5 * cot, 0.5 * cot]
    return np.array(I), np.array(J), np.array(W), area


def lap_apply(x, I, J, W, n):
    """y = L x, with L the positive semi-definite cotangent Laplacian."""
    y = np.zeros(n)
    np.add.at(y, I, W * (x[I] - x[J]))
    return y


def cg(apply, b, diag, x0=None, iters=4000, tol=1e-10):
    """Jacobi-preconditioned conjugate gradient."""
    x = np.zeros_like(b) if x0 is None else x0.copy()
    r = b - apply(x)
    z = r / diag
    p = z.copy()
    rz = r @ z
    for it in range(iters):
        Ap = apply(p)
        a = rz / max(p @ Ap, 1e-300)
        x += a * p
        r -= a * Ap
        if r @ r < tol * tol * (b @ b):
            break
        z = r / diag
        rz_new = r @ z
        p = z + (rz_new / rz) * p
        rz = rz_new
    return x


def dijkstra(verts, tris, sources):
    """Graph distance along mesh edges: the right scale, slightly zigzag."""
    import heapq
    n = len(verts)
    nbr = [[] for _ in range(n)]
    for tri in tris:
        for k in range(3):
            i, j = tri[k], tri[(k + 1) % 3]
            d = float(np.linalg.norm(verts[i] - verts[j]))
            nbr[i].append((j, d)); nbr[j].append((i, d))
    dist = np.full(n, np.inf)
    heap = []
    for s0 in sources:
        dist[s0] = 0.0
        heap.append((0.0, int(s0)))
    heapq.heapify(heap)
    while heap:
        d, i = heapq.heappop(heap)
        if d > dist[i]:
            continue
        for j, w in nbr[i]:
            if d + w < dist[j]:
                dist[j] = d + w
                heapq.heappush(heap, (d + w, j))
    return dist


def heat_geodesic(verts, tris, sources):
    """
    Smooth geodesic distance from `sources` over the surface: the second half of
    the heat method (Crane et al.): normalize the field's gradient per face,
    take its divergence, and solve a Poisson equation. The gradient directions come from
    graph (Dijkstra) distance rather than heat diffusion, because heat from the
    mouth underflows to zero long before it reaches the arm tips.
    """
    n = len(verts)
    I, J, W, area = cotan_laplacian(verts, tris)
    ldiag = np.zeros(n)
    np.add.at(ldiag, I, W)
    guess = dijkstra(verts, tris, sources)
    # Iron the graph distance's zigzag out of its directions before using them:
    # cotangent smoothing (sources pinned at zero) keeps its overall slope.
    u = guess.copy()
    free = np.ones(n, dtype=bool)
    free[sources] = False
    wsum = np.maximum(ldiag, 1e-12)
    for _ in range(DIR_SMOOTH):
        acc = np.zeros(n)
        np.add.at(acc, I, W * u[J])
        u = np.where(free, 0.5 * u + 0.5 * acc / wsum, u)
    u = -u
    # Normalized negative gradient per face, then its divergence per vertex.
    div = np.zeros(n)
    for tri in tris:
        p = verts[tri]
        nrm = np.cross(p[1] - p[0], p[2] - p[0])
        a2 = np.linalg.norm(nrm)
        if a2 < 1e-14:
            continue
        nrm /= a2
        g = np.zeros(3)
        for k in range(3):
            e = p[(k + 2) % 3] - p[(k + 1) % 3]  # edge opposite vertex k
            g += u[tri[k]] * np.cross(nrm, e)
        g /= a2
        gl = np.linalg.norm(g)
        if gl < 1e-14:
            continue
        X = -g / gl
        for k in range(3):
            i, j, o = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
            e1, e2 = p[(k + 1) % 3] - p[k], p[(k + 2) % 3] - p[k]
            cot_o = float((p[k] - p[(k + 2) % 3]) @ (p[(k + 1) % 3] - p[(k + 2) % 3])) / max(float(np.linalg.norm(np.cross(p[k] - p[(k + 2) % 3], p[(k + 1) % 3] - p[(k + 2) % 3]))), 1e-12)
            cot_j = float((p[k] - p[(k + 1) % 3]) @ (p[(k + 2) % 3] - p[(k + 1) % 3])) / max(float(np.linalg.norm(np.cross(p[k] - p[(k + 1) % 3], p[(k + 2) % 3] - p[(k + 1) % 3]))), 1e-12)
            div[i] += 0.5 * (cot_o * (e1 @ X) + cot_j * (e2 @ X))
    # L phi = -div (positive L); pin the mean, then shift so the sources sit at 0.
    # Warm start from graph distance: CG is slowest on exactly the large smooth ramp
    # a distance field is, so start with it and let CG iron out the zigzags.
    rhs = -(div - div.mean())
    phi = cg(lambda x: lap_apply(x, I, J, W, n) + 1e-8 * area * x, rhs, np.maximum(ldiag, 1e-12), guess)
    if np.corrcoef(phi, guess)[0, 1] < 0:
        phi = cg(lambda x: lap_apply(x, I, J, W, n) + 1e-8 * area * x, -rhs, np.maximum(ldiag, 1e-12), guess)
    phi -= phi[sources].mean()
    print(f"geodesic check: heat/graph distance ratio (median) {np.median(phi[guess > 0.2] / guess[guess > 0.2]):.3f}")
    return np.maximum(phi, 0.0)


# ---------------------------------------------------------------- main

def main():
    verts, tris = mesh_arrays("octopus_clean")
    bverts, btris = mesh_arrays("octopus_body")

    ns = {"__name__": "df_arms_lib"}
    exec(bpy.data.texts["df_arms.py"].as_string().replace("\nbuild()", "\n# build()"), ns)
    crown = np.array([ns["CX"], ns["CY"], ns["CZ"] + 0.01])
    arm_lines = [np.array([tuple(p) for p in ns["centerline"](a)]) for a in ns["ARMS"]]
    arm_radius = ns["radius"]
    start_off = float(ns["START_OFF"])

    body_line = body_centerline(bverts, btris, crown)

    # Chains: dense centerline (for the flow coordinate) + node polyline (for skinning).
    chains = []

    def flow_along(line, spacing_at, offset):
        """Ring index at each centerline point: integral of ds / spacing."""
        s = arclength(line)
        u = s / s[-1]
        f = np.zeros(len(line))
        for i in range(1, len(line)):
            f[i] = f[i - 1] + (s[i] - s[i - 1]) / spacing_at(0.5 * (u[i] + u[i - 1]))
        return f + offset

    body_flow = flow_along(body_line, lambda u: BODY_SPACING, 0.0)
    chains.append(dict(part="body", line=body_line, flow=body_flow, n=BODY_NODES))
    for k, line in enumerate(arm_lines):
        spacing = lambda u: min(ARM_SPACING_MAX, max(ARM_SPACING_MIN, ARM_SPACING_K * arm_radius(u)))
        # Arms start a little out from the crown; their rings continue the count from there.
        flow = flow_along(line, spacing, start_off / ARM_SPACING_MAX)
        chains.append(dict(part=f"arm{k}", line=line, flow=flow, n=ARM_NODES))

    parts, nodes, node_part, node_u, links = [], [], [], [], []
    for ci, ch in enumerate(chains):
        parts.append(ch["part"])
        us = np.linspace(0, 1, ch["n"])
        pts = sample_polyline(ch["line"], us)
        first = len(nodes)
        ch["first"] = first
        ch["nodes"] = pts
        for i, (p, u) in enumerate(zip(pts, us)):
            nodes.append(p)
            node_part.append(ci)
            node_u.append(float(u))
            if i:
                links.append((first + i - 1, first + i))
    # Arms hang from the body node nearest the crown.
    body = chains[0]
    crown_node = body["first"] + int(np.argmin(np.linalg.norm(body["nodes"] - crown, axis=1)))
    for ch in chains[1:]:
        links.append((crown_node, ch["first"]))

    # Each chain's radius along its nodes: arms from the generator; the body measured off the bare head + mantle.
    for ci, ch in enumerate(chains):
        us = np.linspace(0, 1, ch["n"])
        if ci == 0:
            rad = []
            for i, p in enumerate(ch["nodes"]):
                t = ch["nodes"][min(i + 1, ch["n"] - 1)] - ch["nodes"][max(i - 1, 0)]
                t /= np.linalg.norm(t)
                rel = bverts - p
                along = rel @ t
                slab = rel[np.abs(along) < 0.03]
                r = np.median(np.linalg.norm(slab - np.outer(slab @ t, t), axis=1)) if len(slab) > 8 else 0.1
                rad.append(r)
            ch["radius"] = np.array(rad)
        else:
            ch["radius"] = np.array([arm_radius(u) for u in us])

    # Per vertex: two nearest chains (by distance to each chain's surface, so a
    # mantle vertex never latches onto an arm passing close by), attachment, flow.
    nv = len(verts)
    att = np.zeros((nv, 4), dtype=np.uint8)
    tw = np.zeros((nv, 3), dtype=np.uint8)
    flow = np.zeros(nv, dtype=np.float64)
    chain1 = np.zeros(nv, dtype=np.int64)
    chain2 = np.zeros(nv, dtype=np.int64)
    wgt = np.zeros(nv)
    for vi, p in enumerate(verts):
        best = []
        for ci, ch in enumerate(chains):
            d, seg, t = closest_on_polyline(p, ch["nodes"])
            r = ch["radius"][seg] + (ch["radius"][seg + 1] - ch["radius"][seg]) * t
            best.append((d - r, ci, seg, t))
        best.sort()
        (d1, c1, s1, t1), (d2, c2, s2, t2) = best[0], best[1]
        w = float(np.clip(0.5 + (d2 - d1) / (2 * BLEND), 0, 1))  # weight of chain 1
        a1 = chains[c1]["first"] + s1
        a2 = chains[c2]["first"] + s2
        att[vi] = (a1, a1 + 1, a2, a2 + 1)
        tw[vi] = (round(t1 * 255), round(t2 * 255), round(w * 255))

        chain1[vi], chain2[vi], wgt[vi] = c1, c2, w

    # Flow: one geodesic distance field from the mouth over the whole surface, so
    # contours run on unbroken from the head into every arm. Each chain turns that
    # distance into its own ring count (denser where it's thin).
    mouth = np.argsort(np.linalg.norm(verts - np.array([ns["CX"], ns["CY"], ns["CZ"] - 0.12]), axis=1))[:12]
    dist = heat_geodesic(verts, tris, mouth)
    for ch in chains:
        # Ring count as a function of distance from the crown along this chain.
        s_along = arclength(ch["line"]) + np.linalg.norm(ch["line"][0] - crown)
        ch["d2f"] = (np.concatenate([[0.0], s_along]), np.concatenate([[0.0], ch["flow"] - ch["flow"][0] + s_along[0] / (BODY_SPACING if ch is chains[0] else ARM_SPACING_MAX)]))
    def ring_count(ci, d):
        xs, ys = chains[ci]["d2f"]
        f = np.interp(d, xs, ys)
        return f + np.maximum(d - xs[-1], 0) / ARM_SPACING_MIN  # past the end (tip cap)
    for ci in range(len(chains)):
        m1, m2 = chain1 == ci, chain2 == ci
        flow[m1] += wgt[m1] * ring_count(ci, dist[m1])
        flow[m2] += (1 - wgt[m2]) * ring_count(ci, dist[m2])
    print(f"geodesic: max distance {dist.max():.3f}, flow max {flow.max():.1f}")

    # Eye coordinates.
    eye = np.full((nv, 2), 32767, dtype=np.int16)  # far away
    eye_meta = []
    for e in EYES:
        hit, n = np.asarray(e["hit"]), np.asarray(e["normal"], dtype=np.float64)
        n /= np.linalg.norm(n)
        near = verts[np.linalg.norm(verts - hit, axis=1) < 0.09]
        apex = near[np.argmax((near - hit) @ n)]
        up = np.array([0.0, 0.0, 1.0])
        ey = up - n * (up @ n)
        ey /= np.linalg.norm(ey)
        ex = np.cross(ey, n)
        rel = verts - apex
        close = np.linalg.norm(rel, axis=1) < EYE_RADIUS
        x, y = rel @ ex, rel @ ey
        q = (np.stack([x, y], axis=1) / EYE_RADIUS * 32000).round().astype(np.int16)
        eye[close] = q[close]
        eye_meta.append(dict(apex=to_engine(apex).round(4).tolist()))
        print(f"eye: {int(close.sum())} vertices")

    # Engine coordinates + quantization.
    ev = to_engine(verts)
    lo, hi = ev.min(axis=0), ev.max(axis=0)
    qpos = np.round((ev - lo) / (hi - lo) * 65535 - 32768).astype(np.int16)
    fmax = float(flow.max())
    qflow = np.round(flow / fmax * 65535).astype(np.uint16)
    idx = tris.astype(np.uint16 if nv < 65536 else np.uint32)

    blob = b"".join([qpos.tobytes(), att.tobytes(), tw.tobytes(), qflow.tobytes(), eye.tobytes(), idx.tobytes()])
    with open(OUT + ".bin", "wb") as f:
        f.write(blob)

    en = to_engine(np.array(nodes))
    allpts = ev
    center = (allpts.min(axis=0) + allpts.max(axis=0)) / 2
    extent = float(np.max(np.linalg.norm(allpts - center, axis=1)))
    header = {
        "name": "octopus",
        "source": "octopus-clean.blend (octopus_clean), baked by tools/bake_octopus.py",
        "parts": parts,
        "nodes": {"pos": en.round(5).ravel().tolist(), "part": node_part, "u": [round(u, 4) for u in node_u]},
        "links": [x for l in links for x in l],
        "center": center.round(5).tolist(),
        "extent": round(extent, 5),
        "mesh": {
            "vertices": nv,
            "indices": int(idx.size),
            "indexType": "uint16" if idx.dtype == np.uint16 else "uint32",
            "bboxMin": lo.round(6).tolist(),
            "bboxMax": hi.round(6).tolist(),
            "flowMax": round(fmax, 4),
            "eyeRadius": EYE_RADIUS,
        },
        "eyes": eye_meta,
    }
    with open(OUT + ".json", "w") as f:
        json.dump(header, f, separators=(",", ":"))
    print(f"wrote {OUT}.bin ({len(blob)} bytes) and {OUT}.json: {nv} verts, {len(tris)} tris, {len(nodes)} nodes, flow max {fmax:.1f}")


main()
