import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SphereStatus, pulseScale, CACHE_COLOR, MEMORY_COLOR } from '../public/sphere-status.js';
test('cache state and correction animations affect only the attributed sphere and release particles',()=>{
  const scene=new THREE.Scene(), status=new SphereStatus(scene);
  const employee=id=>({data:{id},color:0x4fd1a5,sphere:new THREE.Mesh(new THREE.SphereGeometry(),new THREE.MeshStandardMaterial({color:0x4fd1a5}))});
  const a=employee('a'),b=employee('b'); scene.add(a.sphere,b.sphere);
  status.cache('a',900); status.update(a,.1,0); status.update(b,.1,0);
  assert.equal(a.sphere.material.emissive.getHex(),CACHE_COLOR); assert.notEqual(b.sphere.material.emissive.getHex(),CACHE_COLOR);
  assert.ok(a.sphere.rotation.y < b.sphere.rotation.y);
  status.evolve('a',a,1000); status.update(a,1,1120);
  assert.equal(a.sphere.scale.x,1.3); assert.equal(a.sphere.material.color.getHex(),MEMORY_COLOR);
  assert.equal(status.bursts.length,1); status.tick(2500); assert.equal(status.bursts.length,0);
  status.cache('a',0); status.update(a,.1,2500); assert.equal(a.sphere.material.emissive.getHex(),a.color);
  status.evolve('a',a,3000); status.reset(); assert.equal(status.states.size,0); assert.equal(status.bursts.length,0);
  assert.equal(pulseScale(2),1);
});
test('reduced motion keeps static color feedback without pulse or particles',()=>{
 const scene=new THREE.Scene(),status=new SphereStatus(scene,()=>true);
 const e={data:{id:'a'},color:0x4fd1a5,sphere:new THREE.Mesh(new THREE.SphereGeometry(),new THREE.MeshStandardMaterial())};
 status.evolve('a',e,0); status.update(e,1,120); assert.equal(e.sphere.scale.x,1);assert.equal(status.bursts.length,0);assert.equal(e.sphere.rotation.y,0);assert.equal(e.sphere.material.color.getHex(),MEMORY_COLOR);
});
