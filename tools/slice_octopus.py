"""
Slice the sculpted octopus into contour rings for Driftform (see ADR 0002).

Run with Blender (5.x), against the art-directed .blend:

    blender --background path/to/octopus-clean.blend \
        --python tools/slice_octopus.py -- src/characters/octopus.rings.json

What it expects inside the .blend:
- `octopus_fused`: the high-res watertight sculpt that gets sliced.
- `octopus_body`:  the head + mantle alone, used to find the body's centerline.
- text block `df_arms.py`: the arm generator; its `centerline()` and `ARMS`
  give each arm's exact centerline, so we slice perpendicular to the arm.

Output (engine coordinates: y up, +z toward the viewer):
- `parts`: part names, e.g. body, arm0..arm7
- `nodes`: soft-body nodes along each centerline (rest positions, part, u)
- `links`: node pairs
- `rings`: one per slice: part, u, node attachment (a, b, t), rest center and
  frame (T along the body, N across it), and the contour as 2D points in the
  (N, B = T x N) plane. Every ring in a part has the same point count and
  starts at the same angle, so rings form a grid the engine can take
  surface normals from.
"""

import json
import math
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "octopus.rings.json"

# Tuning: rings per part and contour points per ring.
BODY_RINGS = 80
BODY_POINTS = 120
ARM_RINGS = 46
ARM_POINTS = 20
BODY_NODES = 10
ARM_NODES = 14
ARM_S_START = 0.03         # arm roots: sliced from the bare arm tube where the full sculpt merges into the web
ARM_S_END = 0.985          # stop just short of the tip cap
WEB_CAP = 1.5              # web lobes reaching past this × the ring's median radius are pulled in and hidden
EYE_POINTS = 24
EYE_MAX_RADIUS = 0.085     # topographic eye rings stop once they spread wider than this
EYE_STEP = 0.006           # depth between eye rings, down from the turret's apex
# Eye turrets, found by raycasting the approved sculpt from a top view through
# the two visible bulges (Blender coords: surface hit point, outward normal).
EYES = [
    dict(name="eyeL", hit=(-0.1228, 0.0, 0.4282), normal=(-0.272, -0.34, 0.9)),
    dict(name="eyeR", hit=(0.0929, 0.0037, 0.4228), normal=(0.192, -0.509, 0.839)),
]
PUPIL = (0.007, 0.03)      # slit pupil half-size across N (vertical-ish) and B (horizontal)
ARM_MAX_RATIO = 1.8        # skip arm slices that still run into the body/web


# ---------------------------------------------------------------- geometry

def mesh_arrays(name):
    ob = bpy.data.objects[name]
    me = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    me.calc_loop_triangles()
    verts = np.array([ob.matrix_world @ v.co for v in me.vertices], dtype=np.float64)
    tris = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
    return verts, tris


def slice_loops(verts, tris, origin, normal):
    """All closed contour loops where the plane (origin, normal) cuts the mesh."""
    d = (verts - origin) @ normal
    s = d[tris] > 0
    crossing = tris[(s.any(axis=1)) & (~s.all(axis=1))]
    if len(crossing) == 0:
        return []

    def cut(i, j):
        di, dj = d[i], d[j]
        t = di / (di - dj)
        return verts[i] + (verts[j] - verts[i]) * t

    # Each crossing triangle contributes one segment between two cut edges.
    edge_pt = {}
    adj = {}
    for tri in crossing:
        cuts = []
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if (d[a] > 0) != (d[b] > 0):
                key = (a, b) if a < b else (b, a)
                if key not in edge_pt:
                    edge_pt[key] = cut(a, b)
                cuts.append(key)
        if len(cuts) == 2:
            adj.setdefault(cuts[0], []).append(cuts[1])
            adj.setdefault(cuts[1], []).append(cuts[0])

    loops, seen = [], set()
    for start in adj:
        if start in seen:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nxt = [e for e in adj[cur] if e != prev]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            if cur == start:
                loops.append(np.array([edge_pt[k] for k in loop]))
                break
            if cur in seen:
                break
            seen.add(cur)
            loop.append(cur)
    return loops


def to_plane(points, c, N, B):
    rel = points - c
    return np.stack([rel @ N, rel @ B], axis=1)


def point_in_polygon(poly):
    """Is the origin inside the 2D polygon?"""
    x, y = poly[:, 0], poly[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    cond = (y > 0) != (y2 > 0)
    xs = x + (0 - y) * (x2 - x) / np.where(y2 - y == 0, 1e-12, y2 - y)
    return np.count_nonzero(cond & (xs > 0)) % 2 == 1


def pick_loop(loops, c, N, B):
    """The loop that wraps the centerline point (or, failing that, the nearest)."""
    best, best_d = None, math.inf
    for lp in loops:
        p2 = to_plane(lp, c, N, B)
        if point_in_polygon(p2):
            return p2
        dist = np.linalg.norm(p2.mean(axis=0))
        if dist < best_d:
            best, best_d = p2, dist
    return best


def resample(p2, count):
    """CCW, `count` points evenly spaced by arc length, starting on the +N axis."""
    area = 0.5 * np.sum(p2[:, 0] * np.roll(p2[:, 1], -1) - np.roll(p2[:, 0], -1) * p2[:, 1])
    if area < 0:
        p2 = p2[::-1]
    # Start where the contour crosses angle 0 (the +N direction).
    ang = np.abs(np.arctan2(p2[:, 1], p2[:, 0]))
    p2 = np.roll(p2, -int(np.argmin(ang)), axis=0)
    closed = np.vstack([p2, p2[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    targets = np.linspace(0, cum[-1], count, endpoint=False)
    xs = np.interp(targets, cum, closed[:, 0])
    ys = np.interp(targets, cum, closed[:, 1])
    return np.stack([xs, ys], axis=1)


def frames(points):
    """Tangents plus a parallel-transported N that starts as close to world up as possible."""
    pts = np.asarray(points)
    T = np.gradient(pts, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    up = np.array([0.0, 0.0, 1.0])
    N = up - T[0] * (up @ T[0])
    if np.linalg.norm(N) < 1e-6:
        N = np.array([1.0, 0.0, 0.0]) - T[0] * T[0][0]
    N /= np.linalg.norm(N)
    Ns = [N]
    for i in range(1, len(pts)):
        N = Ns[-1] - T[i] * (Ns[-1] @ T[i])
        N /= np.linalg.norm(N)
        Ns.append(N)
    return T, np.array(Ns)


def arclength(points):
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    return cum / cum[-1]


def sample_polyline(points, u):
    s = arclength(points)
    return np.stack([np.interp(u, s, points[:, k]) for k in range(3)], axis=-1)


def max_radius(p2):
    return float(np.max(np.linalg.norm(p2, axis=1))) if p2 is not None else math.inf


# ---------------------------------------------------------------- centerlines

def body_centerline(bverts, btris):
    """Principal axis of the bare body, refined through slice centroids."""
    mean = bverts.mean(axis=0)
    _, _, vt = np.linalg.svd(bverts - mean, full_matrices=False)
    axis = vt[0]
    if axis[1] < 0:  # point toward the mantle (+Y in Blender)
        axis = -axis
    proj = (bverts - mean) @ axis
    lo, hi = proj.min(), proj.max()
    ts = np.linspace(lo + 0.02 * (hi - lo), hi - 0.02 * (hi - lo), 40)
    straight = np.array([mean + axis * t for t in ts])
    T, N = frames(straight)
    cents = []
    for i, c in enumerate(straight):
        B = np.cross(T[i], N[i])
        p2 = pick_loop(slice_loops(bverts, btris, c, T[i]), c, N[i], B)
        cents.append(c if p2 is None else c + N[i] * p2[:, 0].mean() + B * p2[:, 1].mean())
    cents = np.array(cents)
    # Smooth.
    k = np.ones(5) / 5
    sm = np.stack([np.convolve(np.pad(cents[:, j], 2, mode="edge"), k, mode="valid") for j in range(3)], axis=1)
    return sm


def bend_to_crown(line, crown):
    """
    Run the body's centerline from the arm crown, up through the head, then
    out along the mantle. Head slices come out horizontal, like real head
    contours, and the lowest ones become the web flowing into the arms.
    """
    crown = np.asarray(crown, dtype=np.float64)
    # The head's center: the centerline point straight above the crown.
    j = int(np.argmin(np.linalg.norm(line[:, :2] - crown[:2], axis=1)))
    head = line[j]
    j2 = min(j + 4, len(line) - 2)
    out_dir = line[j2 + 1] - line[j2]
    out_dir /= np.linalg.norm(out_dir)
    # Cubic Bezier: leave the crown straight up, arrive along the mantle axis.
    p0, p3 = crown, line[j2]
    p1 = crown + np.array([0, 0, (head[2] - crown[2]) * 0.9])
    p2 = p3 - out_dir * np.linalg.norm(p3 - head) * 0.8
    ts = np.linspace(0, 1, 24)[:, None]
    bez = (1 - ts) ** 3 * p0 + 3 * (1 - ts) ** 2 * ts * p1 + 3 * (1 - ts) * ts ** 2 * p2 + ts ** 3 * p3
    tail = line[-1] + (line[-1] - line[-2]) / np.linalg.norm(line[-1] - line[-2]) * 0.01
    return np.vstack([bez, line[j2 + 1:], tail])


def arm_centerlines_crown():
    ns = {"__name__": "df_arms_lib"}
    exec(bpy.data.texts["df_arms.py"].as_string().replace("\nbuild()", "\n# build()"), ns)
    # Just above the crown center, so the first slice is the web's underside.
    return (ns["CX"], ns["CY"], ns["CZ"] + 0.01)


def arm_centerlines():
    ns = {"__name__": "df_arms_lib"}
    src = bpy.data.texts["df_arms.py"].as_string().replace("\nbuild()", "\n# build()")
    exec(src, ns)
    lines = [np.array([tuple(p) for p in ns["centerline"](a)]) for a in ns["ARMS"]]
    return lines, ns["radius"]


# ---------------------------------------------------------------- slicing

def to_engine(v):
    """Blender (x, y, z) Z-up → engine (x, z, -y) Y-up, +z toward the viewer."""
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)


def main():
    fverts, ftris = mesh_arrays("octopus_fused")
    averts, atris = mesh_arrays("octopus_arms")
    bverts, btris = mesh_arrays("octopus_body")
    arms, arm_radius = arm_centerlines()
    crown = np.asarray(arm_centerlines_crown())
    body = bend_to_crown(body_centerline(bverts, btris), crown)

    parts, nodes, node_part, node_u, links, rings = [], [], [], [], [], []

    def add_part(name, line, n_nodes):
        parts.append(name)
        pi = len(parts) - 1
        us = np.linspace(0, 1, n_nodes)
        pts = sample_polyline(line, us)
        first = len(nodes)
        for i, (p, u) in enumerate(zip(pts, us)):
            nodes.append(p)
            node_part.append(pi)
            node_u.append(float(u))
            if i:
                links.append((first + i - 1, first + i))
        return pi, first

    def attach(first, n_nodes, u):
        f = min(u * (n_nodes - 1), n_nodes - 1 - 1e-6)
        s = int(math.floor(f))
        return first + s, first + s + 1, f - s

    # Body.
    bpi, bfirst = add_part("body", body, BODY_NODES)
    us = np.linspace(0, 1, BODY_RINGS)
    centers = sample_polyline(body, us)
    T, N = frames(centers)
    kept = 0
    for i, (u, c) in enumerate(zip(us, centers)):
        B = np.cross(T[i], N[i])
        p2 = pick_loop(slice_loops(fverts, ftris, c, T[i]), c, N[i], B)
        if p2 is None or len(p2) < 3:
            continue
        a, b, t = attach(bfirst, BODY_NODES, u)
        pts = resample(p2, BODY_POINTS)
        # Web lobes that run out along the arms read as stray lines: pull them in and hide them.
        rad = np.linalg.norm(pts, axis=1)
        cap = WEB_CAP * float(np.median(rad))
        over = rad > cap
        pts[over] *= (cap / rad[over])[:, None]
        rings.append(dict(part=bpi, u=float(u), a=a, b=b, t=t, c=c, T=T[i], N=N[i], pts=pts,
                          hide=set(np.nonzero(over)[0].tolist())))
        kept += 1
    # Drop outliers: a slice that grabbed a much bigger loop than its neighbors.
    body_rings = [r for r in rings if r["part"] == bpi]
    radii = [max_radius(r["pts"]) for r in body_rings]
    drop = set()
    for i, r in enumerate(body_rings):
        around = [radii[j] for j in range(max(0, i - 3), min(len(radii), i + 4)) if j != i]
        if around and radii[i] > 1.5 * sorted(around)[len(around) // 2]:
            drop.add(id(r))
    rings[:] = [r for r in rings if id(r) not in drop]
    print(f"body: {kept - len(drop)}/{BODY_RINGS} rings ({len(drop)} outliers dropped)")
    crown_node = bfirst + int(np.argmin([np.linalg.norm(nodes[bfirst + k] - arms[0][0]) for k in range(BODY_NODES)]))

    # Arms.
    for k, line in enumerate(arms):
        api, afirst = add_part(f"arm{k}", line, ARM_NODES)
        links.append((crown_node, afirst))
        us = np.linspace(ARM_S_START, ARM_S_END, ARM_RINGS)
        centers = sample_polyline(line, us)
        T, N = frames(centers)
        kept = 0
        for i, (u, c) in enumerate(zip(us, centers)):
            B = np.cross(T[i], N[i])
            p2 = pick_loop(slice_loops(fverts, ftris, c, T[i]), c, N[i], B)
            if p2 is None or len(p2) < 3 or max_radius(p2) > ARM_MAX_RATIO * arm_radius(u):
                # Near the root the cut runs into the web; the bare arm tube gives the arm's own contour.
                p2 = pick_loop(slice_loops(averts, atris, c, T[i]), c, N[i], B)
                if p2 is None or len(p2) < 3 or max_radius(p2) > ARM_MAX_RATIO * arm_radius(u):
                    continue
            a, b, t = attach(afirst, ARM_NODES, u)
            rings.append(dict(part=api, u=float(u), a=a, b=b, t=t, c=c, T=T[i], N=N[i], pts=resample(p2, ARM_POINTS)))
            kept += 1
        print(f"arm{k}: {kept}/{ARM_RINGS} rings")

    # Eyes: topographic rings around each turret, down from its apex, plus a slit pupil.
    eye_spots = []
    for e in EYES:
        hit, n = np.asarray(e["hit"]), np.asarray(e["normal"], dtype=np.float64)
        n /= np.linalg.norm(n)
        near = fverts[np.linalg.norm(fverts - hit, axis=1) < 0.09]
        apex = near[np.argmax((near - hit) @ n)]
        loops = []
        h = EYE_STEP * 0.5
        while True:
            c = apex - n * h
            Tn, Nn = frames(np.array([c - n * 0.01, c, c + n * 0.01]))
            Ne = Nn[1]
            Be = np.cross(n, Ne)
            p2 = pick_loop(slice_loops(fverts, ftris, c, n), c, Ne, Be)
            if p2 is None or len(p2) < 3 or max_radius(p2) > EYE_MAX_RADIUS:
                break
            loops.append((c, Ne, resample(p2, EYE_POINTS)))
            h += EYE_STEP
        if not loops:
            print(f"{e['name']}: no rings")
            continue
        loops.reverse()  # base first, apex last
        api, afirst = add_part(e["name"], np.array([loops[0][0], apex + n * 0.004]), 2)
        links.append((bfirst + int(np.argmin([np.linalg.norm(nodes[bfirst + k] - apex) for k in range(BODY_NODES)])), afirst))
        total = len(loops) + 1
        for j, (c, Ne, pts) in enumerate(loops):
            u = j / (total - 1)
            rings.append(dict(part=api, u=u, a=afirst, b=afirst + 1, t=u, c=c, T=n, N=Ne, pts=pts, hide=set()))
        ang = np.linspace(0, 2 * np.pi, EYE_POINTS, endpoint=False)
        slit = np.stack([PUPIL[0] * np.cos(ang), PUPIL[1] * np.sin(ang)], axis=1)
        c = apex + n * 0.004
        rings.append(dict(part=api, u=1.0, a=afirst, b=afirst + 1, t=1.0, c=c, T=n, N=loops[-1][1], pts=slit, hide=set()))
        eye_spots.append((apex, max_radius(loops[0][2]) * 1.15))
        print(f"{e['name']}: {len(loops)} rings + pupil, base radius {max_radius(loops[0][2]):.3f}")

    # Body contours crossing an eye are hidden there, so the eye reads cleanly.
    for r in rings:
        if parts[r["part"]] != "body":
            continue
        Bv = np.cross(r["T"], r["N"])
        p3 = r["c"] + np.outer(r["pts"][:, 0], r["N"]) + np.outer(r["pts"][:, 1], Bv)
        for apex, rad in eye_spots:
            r["hide"] |= set(np.nonzero(np.linalg.norm(p3 - apex, axis=1) < rad)[0].tolist())

    r4 = lambda a: [round(float(x), 4) for x in np.asarray(a).ravel()]
    out = {
        "name": "octopus",
        "source": "octopus-clean.blend (octopus_fused), sliced by tools/slice_octopus.py",
        "parts": parts,
        "nodes": {"pos": r4(to_engine(np.array(nodes))), "part": node_part, "u": [round(u, 4) for u in node_u]},
        "links": [x for l in links for x in l],
        "rings": [
            {
                "part": r["part"], "u": round(r["u"], 4), "a": r["a"], "b": r["b"], "t": round(r["t"], 4),
                "c": r4(to_engine(r["c"])), "T": r4(to_engine(r["T"])), "N": r4(to_engine(r["N"])),
                "pts": r4(r["pts"]),
                **({"hide": sorted(r["hide"])} if r.get("hide") else {}),
            }
            for r in rings
        ],
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}: {len(rings)} rings, {len(nodes)} nodes")


main()
