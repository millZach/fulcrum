"""Auto-fit a humanoid armature to a biped boss mesh, skin it, author a heavy walk, export GLB.

  blender --background --python rig2.py -- <src.glb> <out.glb> <blend-out>

Everything about the skeleton is measured off the mesh (bounds, limb clusters, medial
axes) rather than hard-coded, so the same script handles the hunched original and the
upright rebuild.
"""
import bpy, bmesh, math, sys, os, json
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = argv[0] if argv else "/tmp/blender-rig/boss-current.glb"
OUT = argv[1] if len(argv) > 1 else "/tmp/blender-rig/boss-blender-rigged.glb"
BLEND = argv[2] if len(argv) > 2 else "/tmp/blender-rig/boss_rigged.blend"

FPS, CYCLE = 30, 36
F0, F1 = 1, 1 + CYCLE
LOG = []
def log(*a):
    s = " ".join(str(x) for x in a); LOG.append(s); print("[RIG]", s)

log("SRC", SRC, "-> OUT", OUT)

# ================================================================ import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
mesh_obj = [o for o in bpy.data.objects if o.type == 'MESH'][0]
mesh_obj.name = "boss_mesh"
bpy.context.view_layer.objects.active = mesh_obj
mesh_obj.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh_obj.select_set(False)
PTS = [v.co.copy() for v in mesh_obj.data.vertices]
log("mesh:", len(PTS), "verts,", len(mesh_obj.data.polygons), "polys")

# ================================================================ measure the body
ZMIN = min(p.z for p in PTS); ZMAX = max(p.z for p in PTS)
XMAX = max(abs(p.x) for p in PTS)
H = ZMAX - ZMIN
def zf(f):  return ZMIN + H * f                      # fraction of height -> world z

def band(z, hw):
    return [p for p in PTS if abs(p.z - z) <= hw]

def clusters_x(pts, gap):
    if not pts: return []
    xs = sorted(p.x for p in pts)
    out, cur = [], [xs[0]]
    for a, b in zip(xs, xs[1:]):
        if b - a > gap: out.append(cur); cur = [b]
        else: cur.append(b)
    out.append(cur)
    return [(min(c), max(c), len(c)) for c in out if len(c) >= 8]

def medial_y(pts, trim=0.12):
    """midpoint of the y-extent after trimming the outer `trim` fraction each side.
       Trimming matters: raw min/max is dragged around by claw blades and horn spikes."""
    if not pts: return 0.0
    ys = sorted(p.y for p in pts)
    k = int(len(ys) * trim)
    lo, hi = ys[k], ys[len(ys) - 1 - k]
    return 0.5 * (lo + hi)

HW = 0.030 * H

# --- interior probe: the single most reliable way to keep a joint inside the shell ---
bvh = BVHTree.FromObject(mesh_obj, bpy.context.evaluated_depsgraph_get())
_D = [Vector(d) for d in ((1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1),
                          (.577,.577,.577),(-.577,-.577,.577))]
def votes_inside(p):
    v = 0
    for d in _D:
        n = 0; o = Vector(p)
        for _ in range(80):
            hit = bvh.ray_cast(o, d, 100.0)
            if hit[0] is None: break
            n += 1; o = hit[0] + d * 1e-4
        if n % 2 == 1: v += 1
    return v
def inside(p): return votes_inside(p) >= 5
def depth(p):
    r = bvh.find_nearest(Vector(p))
    return r[3] if r[0] else 0.0

def deep_y(x, z, hint=None, xtol=0.05, steps=44):
    """Scan depth (y) at this x/z for the interior point with the best score.
       Score = clearance from the shell, penalised for straying from `hint`.
       Without the hint a pure deepest-point probe zig-zags: at ankle height the
       thickest cross-section is the back of the foot plate, not the ankle."""
    ys = [p.y for p in PTS if abs(p.z - z) < 0.05 * H and abs(p.x - x) < xtol * H]
    if len(ys) < 6:
        ys = [p.y for p in PTS if abs(p.z - z) < 0.09 * H]
    if not ys: return 0.0, -1.0
    lo, hi = min(ys), max(ys)
    best, bd, bs = 0.5 * (lo + hi), -1.0, -1e9
    for i in range(steps + 1):
        y = lo + (hi - lo) * i / steps
        P = Vector((x, y, z))
        if not inside(P): continue
        d = depth(P)
        sc = d if hint is None else d - 0.75 * abs(y - hint)
        if sc > bs: bs, bd, best = sc, d, y
    return best, bd

def joint(x, z, hint=None, shrink=(1.0, 1.06, 0.94, 0.88, 0.80, 0.70, 0.6)):
    """place a joint at this height, nudging x until a well-clear interior y exists.
       Bone heat needs real clearance: a joint sitting 5 mm inside a shell wall
       makes the solve fail, so keep the best clearance rather than the first hit."""
    bx = by = None; bd = -1.0
    for k in shrink:
        y, d = deep_y(x * k, z, hint)
        if d > bd: bd, bx, by = d, x * k, y
        if bd > 0.035 * H: break
    if bd <= 0.0: return (x, hint or 0.0, z), -1.0
    return (bx, by, z), bd

# --- legs: the two clusters straddling x = 0 low down ------------------
# The arms of this boss reach the floor, so a single fixed gap threshold merges the
# claws into the leg cluster.  Shrink the gap until each inboard cluster is a
# plausible leg width (a leg is never wider than ~45% of the half-span).
def leg_clusters(zfrac):
    pts = band(zf(zfrac), HW)
    for g in (0.055, 0.040, 0.030, 0.022, 0.016):
        cl = clusters_x(pts, g * H)
        left = [c for c in cl if c[1] < -0.04 * XMAX]
        right = [c for c in cl if c[0] > 0.04 * XMAX]
        if not left or not right: continue
        l = max(left, key=lambda c: c[1])         # innermost on each side = the leg
        r = min(right, key=lambda c: c[0])
        if (l[1] - l[0]) < 0.45 * XMAX and (r[1] - r[0]) < 0.45 * XMAX:
            return l, r
    return None

lc = None
for zt in (0.10, 0.14, 0.18, 0.22, 0.26):
    lc = leg_clusters(zt)
    if lc: LEGZ = zt; break
assert lc, "could not find two leg clusters"
LEG_LO = 0.5 * (abs(lc[0][1]) + lc[1][0])             # inboard edge of the legs
LEG_HI = 0.5 * (abs(lc[0][0]) + lc[1][1])             # outboard edge
LEG_X = 0.5 * (LEG_LO + LEG_HI)
log("leg clusters @%.2fH:" % LEGZ, [(round(v, 3) if isinstance(v, float) else v) for c in lc for v in c],
    "-> LEG_X=%.3f (span %.3f..%.3f)" % (LEG_X, LEG_LO, LEG_HI))

# hip = height where the two leg clusters merge into the pelvis
MERGE = 0.34
f = LEGZ + 0.02
while f < 0.55:
    if leg_clusters(f) is None: MERGE = f; break
    f += 0.01
HIP_Z = zf(min(0.42, MERGE + 0.01))
log("legs merge at %.2fH -> HIP_Z=%.3f" % (MERGE, HIP_Z))

ANKLE_Z = zf(0.11)
KNEE_Z = HIP_Z + 0.52 * (ANKLE_Z - HIP_Z)
TOE_Z = zf(0.025)

# chain the hints downward so the leg reads as one smooth column
(HIP_X, HIP_Y, _),   dh = joint(LEG_X, HIP_Z)
(KNEE_X, KNEE_Y, _), dk = joint(LEG_X, KNEE_Z,  HIP_Y)
(ANK_X, ANKLE_Y, _), da = joint(LEG_X, ANKLE_Z, KNEE_Y)
(BALL_X, BALL_Y, _), db = joint(LEG_X, zf(0.05), ANKLE_Y - 0.05 * H)
LEG_X = min(HIP_X, KNEE_X, ANK_X, BALL_X)
foot_band = [p for p in band(zf(0.05), HW) if 0.5 * LEG_LO < p.x < LEG_HI]
TOE_Y = (sorted(p.y for p in foot_band)[max(0, int(len(foot_band) * 0.06))] * 0.55
         + BALL_Y * 0.45) if foot_band else BALL_Y - 0.10 * H
log("leg interior clearances: hip %.3f knee %.3f ankle %.3f ball %.3f" % (dh, dk, da, db))
log("leg chain: hip(%.3f,%.3f) knee(%.3f,%.3f) ankle(%.3f,%.3f) toeY=%.3f"
    % (LEG_X, HIP_Z, KNEE_Y, KNEE_Z, ANKLE_Y, ANKLE_Z, TOE_Y))

# --- arms: outermost cluster at shoulder height ------------------------
# must be a genuinely outboard cluster, otherwise a merged torso+arm band reads as
# one cluster spanning x=0 and the shoulder lands on the wrong side of the body.
def outer(zfrac):
    pts = band(zf(zfrac), HW)
    for g in (0.045, 0.032, 0.022):
        cl = [c for c in clusters_x(pts, g * H)
              if c[0] > 0.28 * XMAX and c[1] > 0.55 * XMAX]
        if cl: return max(cl, key=lambda c: c[1])
    return None

def arm_pts(z, hw, inner):
    return [p for p in band(z, hw) if p.x > inner]

SH_F, EL_F, WR_F, HT_F = 0.73, 0.49, 0.29, 0.21
sh_c = None
for zt in (SH_F, SH_F - 0.03, SH_F + 0.03, SH_F - 0.07):
    sh_c = outer(zt)
    if sh_c: SH_F = zt; break
if sh_c is None: sh_c = (0.55 * XMAX, 0.92 * XMAX, 0)
SH_X = sh_c[0] + 0.14 * (sh_c[1] - sh_c[0])          # just inside the pauldron
log("shoulder cluster @%.2fH: (%.3f, %.3f) -> SH_X=%.3f" % (SH_F, sh_c[0], sh_c[1], SH_X))

def arm_at(zfrac):
    z = zf(zfrac)
    c = outer(zfrac)
    lo = c[0] if c else 0.55 * XMAX
    pts = arm_pts(z, HW, max(lo - 0.02 * H, 0.42 * XMAX))
    if not pts: return SH_X, HIP_Y
    xs = sorted(p.x for p in pts)
    return 0.5 * (xs[0] + xs[-1]), medial_y(pts)

(SH_X, SH_Y, _), _  = joint(SH_X, zf(SH_F))
(EL_X, EL_Y, _), _  = joint(arm_at(EL_F)[0], zf(EL_F), SH_Y)
(WR_X, WR_Y, _), _  = joint(arm_at(WR_F)[0], zf(WR_F), EL_Y - 0.05 * H)
(HT_X, HT_Y, _), _  = joint(arm_at(HT_F)[0], zf(HT_F), WR_Y - 0.07 * H)
log("arm chain: shoulder(%.3f,%.3f,%.3f) elbow(%.3f,%.3f) wrist(%.3f,%.3f) tip(%.3f,%.3f)"
    % (SH_X, SH_Y, zf(SH_F), EL_X, zf(EL_F), WR_X, zf(WR_F), HT_X, zf(HT_F)))

# --- spine: medial line of the central column -------------------------
def spine_y(zfrac):
    z = zf(zfrac)
    return medial_y([p for p in band(z, HW) if abs(p.x) < 0.28 * XMAX])
SPF = dict(hips=0.36, spine=0.47, chest=0.59, neck=0.71, head=0.74, headtip=0.79)
SPY, _hint = {}, None
for _k in ("hips", "spine", "chest", "neck", "head", "headtip"):
    _hint = joint(0.0, zf(SPF[_k]), _hint)[0][1]
    SPY[_k] = _hint
# nose the head bone forward inside the skull so the horn rides with the head
SPY["head"] = SPY["head"] - 0.03 * H
SPY["headtip"] = SPY["headtip"] - 0.10 * H
log("spine Y by height:", {k: round(v, 3) for k, v in SPY.items()})

# ================================================================ bone table
S = {
 "root":  ((0.0, SPY["hips"], zf(0.01)), (0.0, SPY["hips"], zf(0.15)), None, False),
 "hips":  ((0.0, SPY["hips"],  HIP_Z),      (0.0, SPY["spine"], zf(0.47)), "root",  False),
 "spine": ((0.0, SPY["spine"], zf(0.47)),   (0.0, SPY["chest"], zf(0.59)), "hips",  True),
 "chest": ((0.0, SPY["chest"], zf(0.59)),   (0.0, SPY["neck"],  zf(0.71)), "spine", True),
 "neck":  ((0.0, SPY["neck"],  zf(0.71)),   (0.0, SPY["head"],  zf(0.74)), "chest", True),
 "head":  ((0.0, SPY["head"],  zf(0.74)),   (0.0, SPY["headtip"], zf(0.79)), "neck", True),
}
LIMB = {
 "clavicle":  ((0.22 * SH_X, SPY["chest"], zf(SH_F - 0.02)), (SH_X * 0.96, SH_Y, zf(SH_F)), "chest", False),
 "upper_arm": ((SH_X, SH_Y, zf(SH_F - 0.02)), (EL_X, EL_Y, zf(EL_F)), "clavicle", False),
 "forearm":   ((EL_X, EL_Y, zf(EL_F)), (WR_X, WR_Y, zf(WR_F)), "upper_arm", True),
 "hand":      ((WR_X, WR_Y, zf(WR_F)), (HT_X, HT_Y, zf(HT_F)), "forearm", True),
 "thigh":     ((LEG_X, HIP_Y, HIP_Z), (LEG_X, KNEE_Y, KNEE_Z), "hips", False),
 "shin":      ((LEG_X, KNEE_Y, KNEE_Z), (LEG_X, ANKLE_Y, ANKLE_Z), "thigh", True),
 "foot":      ((LEG_X, ANKLE_Y, ANKLE_Z), (LEG_X, BALL_Y, zf(0.05)), "shin", True),
 "toe":       ((LEG_X, BALL_Y, zf(0.05)), (LEG_X, TOE_Y, TOE_Z), "foot", True),
}
BONES = dict(S)
for side, sx in (("R", 1.0), ("L", -1.0)):
    for base, (h, t, par, con) in LIMB.items():
        p = par if par in S else f"{par}.{side}"
        BONES[f"{base}.{side}"] = ((h[0]*sx, h[1], h[2]), (t[0]*sx, t[1], t[2]), p, con)

# ================================================================ pull joints inside
CORE = Vector((0.0, SPY["chest"], zf(0.5)))
def repair(p):
    """safety net: slide the joint in depth first (keeps the limb where it belongs),
       and only fall back to walking it toward the body core"""
    P = Vector(p)
    if inside(P): return P, False
    y, d = deep_y(P.x, P.z)
    if d > 0.0: return Vector((P.x, y, P.z)), True
    for t in (0.08, 0.16, 0.26, 0.38, 0.52):
        Q = P.lerp(CORE, t)
        if inside(Q): return Q, True
    r = bvh.find_nearest(P)
    return (r[0] - r[1] * 0.02 * H, True) if r[0] else (P, True)

fixed = []
for name in list(BONES):
    h, t, par, con = BONES[name]
    nh, fh = repair(h); nt, ft = repair(t)
    if fh or ft: fixed.append(name)
    BONES[name] = (tuple(nh), tuple(nt), par, con)
# re-weld connected chains after repair
for name, (h, t, par, con) in list(BONES.items()):
    if con and par in BONES:
        ph, pt, pp, pc = BONES[par]
        BONES[name] = (pt, t, par, con)
log("joints repaired toward the core:", fixed or "none")

audit = {}
for name, (h, t, par, con) in BONES.items():
    if name == "root": continue
    A, B = Vector(h), Vector(t)
    audit[name] = "%d/9" % sum(1 for i in range(9) if inside(A.lerp(B, i / 8.0)))
log("inside-mesh audit:", json.dumps(audit))

# ================================================================ armature
arm_data = bpy.data.armatures.new("boss_rig")
arm = bpy.data.objects.new("boss_rig", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
for name, (h, t, par, con) in BONES.items():
    b = eb.new(name); b.head, b.tail = Vector(h), Vector(t)
    b.use_deform = (name != "root")
for name, (h, t, par, con) in BONES.items():
    if par: eb[name].parent = eb[par]; eb[name].use_connect = con
for b in eb:
    d = (b.tail - b.head).normalized()
    ref = Vector((0, 0, 1)) if abs(d.z) < 0.85 else Vector((0, -1, 0))
    b.align_roll(ref - d * ref.dot(d))
bpy.ops.object.mode_set(mode='OBJECT')
arm.select_set(False)
log("armature:", len(arm_data.bones), "bones,", sum(1 for b in arm_data.bones if b.use_deform), "deforming")

# ================================================================ skinning
def coverage(ob):
    idx = {g.index for g in ob.vertex_groups
           if g.name in arm_data.bones and arm_data.bones[g.name].use_deform}
    return sum(1 for v in ob.data.vertices
               if sum(g.weight for g in v.groups if g.group in idx) > 1e-4) / max(1, len(ob.data.vertices))

def clear_groups(ob):
    for g in list(ob.vertex_groups): ob.vertex_groups.remove(g)
    for m in list(ob.modifiers):
        if m.type == 'ARMATURE': ob.modifiers.remove(m)
    ob.parent = None

def select_only(*objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[-1]

method = None
clear_groups(mesh_obj); select_only(mesh_obj, arm)
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    covA = coverage(mesh_obj)
    log("path A (bone heat on source mesh): coverage %.4f" % covA)
    if covA > 0.98: method = "A: bone heat directly on the source mesh"
except Exception as e:
    log("path A raised:", repr(e))

if method is None:
    log("path A insufficient -> path B (voxel proxy + weight transfer)")
    clear_groups(mesh_obj)
    proxy = mesh_obj.copy(); proxy.data = mesh_obj.data.copy(); proxy.name = "proxy"
    bpy.context.collection.objects.link(proxy)
    select_only(proxy)
    covP, vox = 0.0, None
    for vs in (0.0125, 0.020, 0.030):
        if proxy.name not in bpy.data.objects:
            proxy = mesh_obj.copy(); proxy.data = mesh_obj.data.copy(); proxy.name = "proxy"
            bpy.context.collection.objects.link(proxy)
        else:
            proxy.data = mesh_obj.data.copy()
        clear_groups(proxy)
        select_only(proxy)
        rm = proxy.modifiers.new("rm", 'REMESH'); rm.mode = 'VOXEL'
        rm.voxel_size = vs * H; rm.adaptivity = 0.0
        bpy.ops.object.modifier_apply(modifier=rm.name)
        # Voxel remeshing leaves tiny floating islands (spike tips, loose plates).
        # Bone heat is a Laplacian solve and refuses outright when the mesh has
        # disconnected components, so keep only the main shell.
        bm = bmesh.new(); bm.from_mesh(proxy.data)
        seen, comps = set(), []
        for v in bm.verts:
            if v.index in seen: continue
            stack, cur = [v], []
            seen.add(v.index)
            while stack:
                w = stack.pop(); cur.append(w.index)
                for e in w.link_edges:
                    o = e.other_vert(w)
                    if o.index not in seen:
                        seen.add(o.index); stack.append(o)
            comps.append(cur)
        if len(comps) > 1:
            comps.sort(key=len, reverse=True)
            keep = set(comps[0])
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index not in keep],
                             context='VERTS')
            bm.to_mesh(proxy.data)
            log("  stripped %d loose island(s) from the proxy (%d -> %d verts)"
                % (len(comps) - 1, len(seen), len(proxy.data.vertices)))
        bm.free()
        select_only(proxy, arm)
        try:
            bpy.ops.object.parent_set(type='ARMATURE_AUTO')
            covP = coverage(proxy)
        except Exception as e:
            covP = 0.0
        log("voxel proxy %.4f m -> %d verts, heat coverage %.4f"
            % (vs * H, len(proxy.data.vertices), covP))
        if covP > 0.9: vox = vs; break
    VOXEL_USED = vox
    select_only(proxy, mesh_obj)
    dt = mesh_obj.modifiers.new("dt", 'DATA_TRANSFER')
    dt.object = proxy; dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}; dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'; dt.layers_vgroup_select_dst = 'NAME'
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    select_only(mesh_obj, arm)
    bpy.ops.object.parent_set(type='ARMATURE_NAME')
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='BONE_DEFORM')
    covB = coverage(mesh_obj)
    log("path B coverage %.4f" % covB)
    if covB > 0.98:
        method = ("B: bone heat on a %.3f m voxel-remeshed proxy, weights transferred back "
                  "(POLYINTERP_NEAREST)" % (VOXEL_USED * H))
    bpy.data.objects.remove(proxy, do_unlink=True)

# --- Path D: deterministic geometric bind (inverse-distance to bone segments) ---
# Bone heat is a Laplacian solve over the surface and simply refuses on some shells.
# This falls back to something predictable rather than to envelope radii, which
# misassign big outboard parts like the pauldrons.
if method is None:
    log("path B insufficient -> path D (inverse-distance geometric bind)")
    clear_groups(mesh_obj)
    select_only(mesh_obj, arm)
    bpy.ops.object.parent_set(type='ARMATURE_NAME')
    segs = [(n, Vector(h), Vector(t)) for n, (h, t, pp, cc) in BONES.items() if n != "root"]
    grp = {n: (mesh_obj.vertex_groups.get(n) or mesh_obj.vertex_groups.new(name=n))
           for n, _, _ in segs}
    EPS, POW, K = 0.004 * H, 3.5, 4
    for v in mesh_obj.data.vertices:
        co = v.co
        ds = []
        for n, a, b in segs:
            ab = b - a
            u = max(0.0, min(1.0, (co - a).dot(ab) / (ab.length_squared or 1e-9)))
            ds.append(((co - (a + ab * u)).length, n))
        ds.sort()
        near = ds[:K]
        ws = [(1.0 / (d + EPS)) ** POW for d, _ in near]
        tot = sum(ws) or 1.0
        for (d, n), w in zip(near, ws):
            grp[n].add([v.index], w / tot, 'REPLACE')
    bpy.context.view_layer.objects.active = mesh_obj
    select_only(mesh_obj)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='BONE_DEFORM', factor=0.6, repeat=6)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='BONE_DEFORM')
    covD = coverage(mesh_obj)
    log("path D coverage %.4f" % covD)
    if covD > 0.98:
        method = ("D: deterministic inverse-distance bind to the %d bone segments "
                  "(1/d^3.5, 4 influences, 6 smoothing passes) - bone heat refused to solve"
                  % len(segs))

if method is None:
    log("path D insufficient -> path C (envelope weights)")
    clear_groups(mesh_obj)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for b in arm_data.edit_bones:
        r = max(0.045 * H, (b.tail - b.head).length * 0.62)
        b.head_radius = b.tail_radius = r; b.envelope_distance = r * 1.9
    bpy.ops.object.mode_set(mode='OBJECT')
    select_only(mesh_obj, arm)
    bpy.ops.object.parent_set(type='ARMATURE_ENVELOPE')
    log("path C coverage %.4f" % coverage(mesh_obj))
    method = "C: envelope weights (bone heat failed on both the source mesh and the proxy)"
log("WEIGHTING METHOD =", method)

def patch_orphans(ob):
    segs = [(n, Vector(h), Vector(t)) for n, (h, t, p, c) in BONES.items() if n != "root"]
    gidx = {g.name: g for g in ob.vertex_groups}
    for n, _, _ in segs:
        if n not in gidx: gidx[n] = ob.vertex_groups.new(name=n)
    deform = {gidx[n].index for n, _, _ in segs}
    orphans = [v.index for v in ob.data.vertices
               if sum(g.weight for g in v.groups if g.group in deform) <= 1e-4]
    for vi in orphans:
        co = ob.data.vertices[vi].co
        best, bd = None, 1e9
        for n, a, b in segs:
            ab = b - a; u = max(0.0, min(1.0, (co - a).dot(ab) / (ab.length_squared or 1e-9)))
            d = (co - (a + ab * u)).length
            if d < bd: bd, best = d, n
        gidx[best].add([vi], 1.0, 'REPLACE')
    return len(orphans)
log("orphan verts patched to nearest bone:", patch_orphans(mesh_obj),
    "-> coverage %.4f" % coverage(mesh_obj))

try:
    select_only(mesh_obj)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='BONE_DEFORM', factor=0.5, repeat=2)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='BONE_DEFORM')
    log("weights smoothed x2 + normalised -> coverage %.4f" % coverage(mesh_obj))
except Exception as e:
    log("smoothing skipped:", repr(e))

# ================================================================ pose helpers
scn = bpy.context.scene
scn.render.fps = FPS
scn.frame_start, scn.frame_end = F0, F1
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = arm; arm.select_set(True)
bpy.ops.object.mode_set(mode='POSE')
for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
REST = {pb.name: pb.bone.matrix_local.to_3x3() for pb in arm.pose.bones}
RESTI = {k: v.inverted() for k, v in REST.items()}
def rot(name, *pairs):
    q = Quaternion((1, 0, 0, 0))
    for axis, deg in pairs:
        if abs(deg) > 1e-9:
            q = q @ Quaternion(RESTI[name] @ Vector(axis), math.radians(deg))
    arm.pose.bones[name].rotation_quaternion = q
def loc(name, wd): arm.pose.bones[name].location = RESTI[name] @ Vector(wd)
XR, YR, ZR = (1, 0, 0), (0, 1, 0), (0, 0, 1)
TAU = math.tau

# ================================================================ walk cycle
# positive rotation about world +X swings a downward limb BACKWARD; world pitches add
# down each leg chain, so local = world - rest - sum(ancestor locals).
def pitch(dy, dz): return math.atan2(dy, -dz)
def seg(n):
    h, t, _, _ = BONES[n]; return Vector(t) - Vector(h)
_th, _sh, _ft = seg("thigh.R"), seg("shin.R"), seg("foot.R")
L1, L2 = _th.length, _sh.length
P1R, P2R, P3R = pitch(_th.y, _th.z), pitch(_sh.y, _sh.z), pitch(_ft.y, _ft.z)
ANK_Y0, ANK_Z0 = BONES["foot.R"][0][1], BONES["foot.R"][0][2]
HIPY0, HIPZ0 = BONES["thigh.R"][0][1], BONES["thigh.R"][0][2]
LIFT = 0.055 * H
HEEL = 0.055 * H                                    # ankle rises as the heel peels
# Stride is limited by how far the leg can actually reach: overrunning it makes the
# IK clamp, the foot leaves its plant and the walk starts to skate.
_dz = ANK_Z0 - (HIPZ0 - 0.030 * H)
_reach = 0.97 * (L1 + L2)
_dymax = math.sqrt(max(0.0, _reach * _reach - _dz * _dz))
STRIDE = max(0.06 * H, min(0.15 * H, 1.8 * (_dymax - abs(ANK_Y0 - HIPY0))))
log("leg IK: L1=%.4f L2=%.4f reach=%.3f rest pitch thigh=%.1f shin=%.1f foot=%.1f; "
    "stride=%.3f (cap %.3f) lift=%.3f heel=%.3f"
    % (L1, L2, L1 + L2, math.degrees(P1R), math.degrees(P2R), math.degrees(P3R),
       STRIDE, 1.8 * (_dymax - abs(ANK_Y0 - HIPY0)), LIFT, HEEL))

def smoother(u): return u * u * u * (u * (u * 6 - 15) + 10)
FRAME_LIFT = [0.0] * (CYCLE + 2)      # measured ground-clamp, one value per frame
CUR_LIFT = 0.0
def foot_target(psi):
    p = psi % TAU
    if p < math.pi:                                    # stance: planted, travelling back
        heel = HEEL * max(0.0, -math.cos(psi + 0.45)) ** 2
        return ANK_Y0 + STRIDE * (p / math.pi - 0.5), ANK_Z0 + heel + CUR_LIFT
    u = (p - math.pi) / math.pi                        # swing: eased return, lifted
    return (ANK_Y0 + STRIDE * (0.5 - smoother(u)),
            ANK_Z0 + LIFT * math.sin(math.pi * u) ** 0.85 + CUR_LIFT)

def solve_leg(hy, hz, psi):
    ay, az = foot_target(psi)
    dy, dz = ay - hy, az - hz
    r = max(abs(L1 - L2) + 0.01 * H, min(math.hypot(dy, dz), (L1 + L2) * 0.995))
    pr = pitch(dy, dz)
    ca = max(-1.0, min(1.0, (L1*L1 + r*r - L2*L2) / (2*L1*r)))
    cg = max(-1.0, min(1.0, (L2*L2 + r*r - L1*L1) / (2*L2*r)))
    thigh = (pr - math.acos(ca)) - P1R                 # knee bulges forward
    knee = (pr + math.acos(cg)) - P2R - thigh
    toeoff = max(0.0, -math.cos(psi + 0.45)) ** 2
    p = psi % TAU
    sw = math.sin(math.pi * (p - math.pi) / math.pi) if p > math.pi else 0.0
    ankle = math.radians(-22.0 * toeoff + 7.0 * sw) - thigh - knee
    return math.degrees(thigh), math.degrees(knee), math.degrees(ankle), 17.0 * toeoff

def arm_swing(psi_leg):
    a = psi_leg + math.pi - 0.5                        # counter-swing, with a little lag
    return (20.0 * math.cos(a),                        # shoulder pitch, + = trailing
            -(7.0 + 9.0 * math.cos(a + 2.2)),          # elbow pump
            8.0 + 6.0 * abs(math.sin(a)),              # swing wide of the thighs
            -6.0 + 9.0 * math.cos(a + 1.2))            # wrist

def warp(t): return t + 0.055 * math.sin(TAU * t)
ROOT_LIFT = 0.0

def pose_at(t, frame=None):
    global CUR_LIFT
    CUR_LIFT = FRAME_LIFT[frame - F0] if frame is not None else 0.0
    phi = TAU * warp(t % 1.0)
    loc("root", (0.0, 0.0, ROOT_LIFT))                 # static trim only, never travel
    bob = (-0.019 - 0.011 * math.cos(2 * phi + 0.5)
           - 0.005 * max(0.0, math.cos(2 * phi + 0.9)) ** 3) * H
    loc("hips", (0.021 * H * math.sin(phi), 0.0, bob))
    rot("hips",  (ZR, -6.0 * math.cos(phi)), (YR, -4.0 * math.sin(phi)), (XR, 2.5))
    rot("spine", (ZR,  3.5 * math.cos(phi)), (YR,  2.0 * math.sin(phi)),
                 (XR, -1.5 + 1.6 * math.cos(2 * phi)))
    rot("chest", (ZR,  7.0 * math.cos(phi)), (YR,  1.5 * math.sin(phi)),
                 (XR, -1.0 + 1.5 * math.cos(2 * phi + 1.0)))
    rot("neck",  (XR, -2.0 * math.cos(2 * phi)))
    rot("head",  (XR,  3.2 * math.cos(2 * phi + 0.6)), (ZR, -2.5 * math.cos(phi)))
    bpy.context.view_layer.update()                    # hips are posed: read the real hip
    for side, psi in (("R", phi), ("L", phi + math.pi)):
        Hh = arm.matrix_world @ arm.pose.bones[f"thigh.{side}"].head
        th, kn, an, to = solve_leg(Hh.y, Hh.z, psi)
        rot(f"thigh.{side}", (XR, th)); rot(f"shin.{side}", (XR, kn))
        rot(f"foot.{side}",  (XR, an)); rot(f"toe.{side}",  (XR, to))
    for side, sgn, psi in (("R", 1.0, phi), ("L", -1.0, phi + math.pi)):
        sh, el, ab, wr = arm_swing(psi)
        rot(f"clavicle.{side}",  (XR, 2.0 * math.cos(psi + math.pi - 0.5)),
                                 (YR, sgn * 2.5 * math.sin(psi)))
        rot(f"upper_arm.{side}", (XR, sh), (YR, sgn * -ab))
        rot(f"forearm.{side}",   (XR, el))
        rot(f"hand.{side}",      (XR, wr))

def frame_minz():
    out = []
    for f in range(F0, F1 + 1):
        scn.frame_set(f); pose_at((f - F0) / float(CYCLE), f)
        bpy.context.view_layer.update()
        ev = mesh_obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        m = ev.to_mesh()
        out.append(min((ev.matrix_world @ v.co).z for v in m.vertices))
        ev.to_mesh_clear()
    return out

# Ground clamp: no IK solver can know where the *skin* ends up, so measure the
# deformed mesh per frame and feed the penetration back into the ankle targets.
zs = frame_minz()
log("ground pass 0: min %.4f max %.4f (ground %.4f)" % (min(zs), max(zs), ZMIN))
CAP = 0.05 * H
for it in range(3):
    for i, z in enumerate(zs):
        FRAME_LIFT[i] = max(0.0, min(CAP, FRAME_LIFT[i] + (ZMIN - z)))
    FRAME_LIFT[CYCLE] = FRAME_LIFT[0]                       # keep the loop seamless
    sm = FRAME_LIFT[:CYCLE]                                 # circular 1-2-1 smoothing
    FRAME_LIFT[:CYCLE] = [0.25 * sm[(i - 1) % CYCLE] + 0.5 * sm[i] + 0.25 * sm[(i + 1) % CYCLE]
                          for i in range(CYCLE)]
    FRAME_LIFT[CYCLE] = FRAME_LIFT[0]
    zs = frame_minz()
    log("ground pass %d: min %.4f max %.4f  clamp %.4f..%.4f"
        % (it + 1, min(zs), max(zs), min(FRAME_LIFT[:CYCLE]), max(FRAME_LIFT[:CYCLE])))
ROOT_LIFT = 0.0   # the per-frame clamp already centres the contact; no static trim needed
log("residual ground error: %+.4f .. %+.4f of a %.2f-tall model; ROOT_LIFT=%+.4f"
    % (min(zs) - ZMIN, max(zs) - ZMIN, H, ROOT_LIFT))
for pb in arm.pose.bones:
    pb.rotation_quaternion = Quaternion((1, 0, 0, 0)); pb.location = (0, 0, 0)

# ================================================================ key it
action = bpy.data.actions.new("walk")
arm.animation_data_create(); arm.animation_data.action = action
try:
    arm.animation_data.action_slot = action.slots.new(id_type='OBJECT', name="walk")
except Exception as e:
    log("slot API not used:", repr(e))
KEYED = ["root", "hips", "spine", "chest", "neck", "head"] + \
        [f"{b}.{s}" for s in ("R", "L")
         for b in ("clavicle", "upper_arm", "forearm", "hand", "thigh", "shin", "foot", "toe")]
for f in range(F0, F1 + 1):
    scn.frame_set(f); pose_at((f - F0) / float(CYCLE), f)
    for n in KEYED:
        pb = arm.pose.bones[n]
        pb.keyframe_insert("rotation_quaternion", frame=f)
        if n in ("hips", "root"): pb.keyframe_insert("location", frame=f)

def all_fcurves(act):
    fcs = list(getattr(act, "fcurves", []) or [])
    for L in getattr(act, "layers", []):
        for st in getattr(L, "strips", []):
            for cb in getattr(st, "channelbags", []): fcs.extend(cb.fcurves)
    return fcs
for fc in all_fcurves(action):
    for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'
log("action 'walk': %d fcurves, frames %d..%d = %.2f s @ %d fps (frame %d repeats frame %d)"
    % (len(all_fcurves(action)), F0, F1, CYCLE / float(FPS), FPS, F1, F0))

bpy.ops.object.mode_set(mode='OBJECT')
tr = arm.animation_data.nla_tracks.new(); tr.name = "walk"
tr.strips.new("walk", F0, action).name = "walk"
arm.animation_data.action = action
try: arm.animation_data.action_slot = action.slots[0]
except Exception: pass
bpy.ops.wm.save_as_mainfile(filepath=BLEND)

# ================================================================ export
scn.frame_set(F0)
kw = dict(filepath=OUT, export_format='GLB', use_selection=False,
          export_animations=True, export_animation_mode='ACTIONS',
          export_nla_strips=False, export_frame_range=False,
          export_bake_animation=True, export_optimize_animation_size=False,
          export_skins=True, export_influence_nb=4, export_def_bones=False,
          export_apply=False, export_yup=True, export_image_format='AUTO',
          export_materials='EXPORT', export_anim_single_armature=True,
          export_reset_pose_bones=True, export_force_sampling=True)
try:
    bpy.ops.export_scene.gltf(**kw)
except TypeError as e:
    log("trimming export kwargs:", repr(e))
    for b in ("export_optimize_animation_size", "export_bake_animation", "export_force_sampling",
              "export_influence_nb", "export_reset_pose_bones", "export_anim_single_armature"):
        kw.pop(b, None)
    bpy.ops.export_scene.gltf(**kw)
log("exported %s (%d bytes)" % (OUT, os.path.getsize(OUT)))
with open(OUT + ".log.txt", "w") as fh:
    fh.write("\n".join(LOG) + "\nMETHOD=%s\n" % method)
print("[RIG] DONE")
