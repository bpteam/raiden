// Self-checks for seam visibility and dowel layout on simple solids (function tests, not sample models).
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { loadManifold } from '../src/core/geom';
import { coveredFraction, planJoints } from '../src/core/prepare';

const w = await loadManifold();
const { Manifold } = w;
const at = (m: InstanceType<typeof Manifold>, h: number, d = 3) => coveredFraction(m.slice(h), m.slice(h + d), m.slice(h - d), d);

const body = Manifold.cylinder(100, 20, 20, 96);
assert.ok(at(body, 50) < 0.05, 'plain cylinder seam is fully visible');
const cone = Manifold.cylinder(100, 30, 10, 96);
assert.ok(at(cone, 50) < 0.05, 'gentle slope does not count as hiding');
// cape: tube hanging outside the body, attached at the top
const cape = body.add(Manifold.cylinder(9, 24, 24, 96).subtract(Manifold.cylinder(9, 22, 22, 96)).translate([0, 0, 51])).add(Manifold.cylinder(2, 24, 24, 96).translate([0, 0, 58]));
assert.ok(at(cape, 50) > 0.95, `seam under a cape hem is hidden (got ${at(cape, 50)})`);

const big = Manifold.cylinder(100, 30, 30, 96);
const pins = planJoints(w, big.slice(50), big, new Matrix4(), 50);
assert.ok(pins.length >= 2, `wide section gets ≥2 dowels (got ${pins.length})`);
for (const p of pins) assert.ok(Math.hypot(p.p[0], p.p[1]) + p.r + 1.6 <= 30, 'dowel keeps wall to the surface');
const thin = Manifold.cylinder(100, 3, 3, 48);
assert.equal(planJoints(w, thin.slice(50), thin, new Matrix4(), 50).length, 0, 'too-thin island gets no dowel (reported as glue-only)');
const flat = Manifold.cube([60, 60, 8], true);
for (const p of planJoints(w, flat.slice(0), flat, new Matrix4(), 0)) assert.ok(p.depth <= 4, `shallow part shrinks hole depth (got ${p.depth})`);
console.log('unit: all checks passed');
