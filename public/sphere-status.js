import * as THREE from 'three';
export const CACHE_COLOR = 0x00f3ff;
export const MEMORY_COLOR = 0xb87916;
export function pulseScale(age) {
  if (age < 0 || age >= 1.4) return 1;
  if (age <= .12) return 1 + .3 * Math.sin(age / .12 * Math.PI / 2);
  return 1 + .3 * Math.exp(-(age - .12) * 5) * Math.cos((age - .12) * 16);
}
export class SphereStatus {
  constructor(scene, reducedMotion = () => false) { this.scene=scene; this.reducedMotion=reducedMotion; this.states=new Map(); this.bursts=[]; this.targetColor=new THREE.Color(); }
  cache(id, cached) { const s=this.states.get(id) || {}; s.cached=Number(cached)>0; this.states.set(id,s); }
  evolve(id, employee, now) {
    const s=this.states.get(id) || {}; s.evolved=true; s.pulse=now; this.states.set(id,s);
    if(this.reducedMotion() || !employee) return;
    // Fixed budget and lifetime; repeated writes never grow the scene without bound.
    while(this.bursts.length>=12) this.removeBurst(this.bursts[0]);
    const n=72, positions=new Float32Array(n*3), velocity=new Float32Array(n*3);
    for(let i=0;i<n;i++) { const v=new THREE.Vector3(Math.random()-.5,Math.random()-.5,Math.random()-.5).normalize().multiplyScalar(1.5+Math.random()*2.5); v.toArray(velocity,i*3); }
    const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const material=new THREE.PointsMaterial({color:0xffbd49,size:.095,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
    const points=new THREE.Points(geometry,material); employee.sphere.getWorldPosition(points.position); this.scene.add(points);
    this.bursts.push({points,velocity,start:now});
  }
  update(employee, dt, now) {
    const s=this.states.get(employee.data.id), mat=employee.sphere.material;
    employee.sphere.rotation.y += this.reducedMotion() ? 0 : dt * (s?.cached ? .055 : .32);
    mat.emissive.setHex(s?.cached ? CACHE_COLOR : employee.color);
    if(s?.cached) mat.emissiveIntensity=Math.max(.65,mat.emissiveIntensity);
    mat.color.lerp(this.targetColor.setHex(s?.evolved ? MEMORY_COLOR : employee.color),Math.min(1,dt*5));
    employee.sphere.scale.setScalar(this.reducedMotion() ? 1 : pulseScale(s?.pulse === undefined ? 2 : (now-s.pulse)/1000));
  }
  tick(now) {
    for(const b of [...this.bursts]) {
      const age=(now-b.start)/1000; if(age>=1.4) {this.removeBurst(b);continue;}
      const a=b.points.geometry.attributes.position;
      for(let i=0;i<a.count;i++) a.setXYZ(i,b.velocity[i*3]*age,b.velocity[i*3+1]*age,b.velocity[i*3+2]*age);
      a.needsUpdate=true; b.points.material.opacity=1-age/1.4;
    }
  }
  removeBurst(b) { this.scene.remove(b.points); b.points.geometry.dispose(); b.points.material.dispose(); this.bursts.splice(this.bursts.indexOf(b),1); }
  remove(id) { this.states.delete(id); }
  reset() { this.states.clear(); for(const b of [...this.bursts]) this.removeBurst(b); }
}
