// Carrier-scoped Tencent jigsaw. Images and challenge URLs stay in memory.
export function readJtDragState() {
  const root = document.querySelector('#tcaptcha_transform_dy');
  const elements = ['.tencent-captcha-dy__verify-bg-img', '.tencent-captcha-dy__fg-item',
    '.tencent-captcha-dy__slider-block', '.tencent-captcha-dy__verify-slider-area']
    .map(selector => root?.querySelectorAll(selector));
  if (elements.some(list => list?.length !== 1)) return null;
  const [bg, piece, knob, track] = elements.map(list => list[0]);
  for (const e of [bg, piece, knob, track]) {
    if (e.getBoundingClientRect().width <= 0 || e.getBoundingClientRect().height <= 0) return null;
    for (let parent = e; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < .99) return null;
    }
  }
  const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const b = rect(bg), p = rect(piece), k = rect(knob), t = rect(track);
  const styles = [bg, piece].map(e => getComputedStyle(e));
  // Piece and knob x change during a held drag; their assets, crop, y and
  // dimensions must remain those of the puzzle that was analysed.
  return { generation: JSON.stringify([styles.map(s => s.backgroundImage),
    styles.map(s => s.backgroundSize), styles.map(s => s.backgroundPosition),
    b, [p[1], p[2], p[3]], [k[1], k[2], k[3]], t, root.innerText]),
  pieceX: p[0], knobX: k[0] };
}

export async function readJtSlider() {
  const root = document.querySelector('#tcaptcha_transform_dy');
  const bg = root?.querySelector('.tencent-captcha-dy__verify-bg-img');
  const pieces = root?.querySelectorAll('.tencent-captcha-dy__fg-item');
  const knob = root?.querySelector('.tencent-captcha-dy__slider-block');
  const track = root?.querySelector('.tencent-captcha-dy__verify-slider-area');
  if (!bg || pieces?.length !== 1 || !knob || !track) return null;
  const piece = pieces[0];
  const rect = e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const painted = e => {
    const r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0)return false;
    for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)<.99)return false;}
    return true;
  };
  if (![bg,piece,knob,track].every(painted)) return null;
  const initial = readJtDragState();
  if (!initial) return null;
  const css = [bg,piece].map(e=>getComputedStyle(e));
  const urls = css.map(s=>s.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);
  if (urls.some(u=>!u)) return null;
  const allowed = u => {try{const x=new URL(u);return x.protocol==='https:' && ['ca.turing.captcha.qcloud.com','turing.captcha.qcloud.com','turing.captcha.gtimg.com'].includes(x.hostname);}catch{return false;}};
  if (!urls.every(allowed)) return null;
  const images = await Promise.all(urls.map(async url=>{const im=new Image();im.crossOrigin='anonymous';im.src=url;await im.decode();return im;}));
  const [b,p,k,t]=[bg,piece,knob,track].map(rect);
  const [background,sprite]=images;
  if(background.width<100||background.width>1024||background.height>600||sprite.width>2048||sprite.height>2048)return null;
  const scale=background.width/b.width;
  const sizes=css[1].backgroundSize.split(' ').map(parseFloat);
  const pos=css[1].backgroundPosition.split(' ').map(parseFloat);
  if(sizes.length!==2||pos.length!==2||[...sizes,...pos].some(x=>!Number.isFinite(x)))return null;
  if(Math.abs(sizes[0]*scale-sprite.width)>1||Math.abs(sizes[1]*scale-sprite.height)>1)return null;
  const crop={x:-pos[0]*scale,y:-pos[1]*scale,width:Math.round(p.width*scale),height:Math.round(p.height*scale)};
  if(crop.width<20||crop.height<20||crop.width>160||crop.height>160||crop.x<0||crop.y<0||crop.x+crop.width>sprite.width+1||crop.y+crop.height>sprite.height+1)return null;
  const canvas=document.createElement('canvas');canvas.width=background.width;canvas.height=background.height;
  canvas.getContext('2d').drawImage(background,0,0);
  const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const sub=document.createElement('canvas');sub.width=crop.width;sub.height=crop.height;
  sub.getContext('2d').drawImage(sprite,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
  const alpha=sub.getContext('2d').getImageData(0,0,crop.width,crop.height).data;
  const signature=JSON.stringify([urls,css[1].backgroundPosition,css[1].backgroundSize,b,p,k,t]);
  // Re-read after asynchronous decode: a refreshed challenge cannot use old assets.
  const current=[bg,piece].map(e=>getComputedStyle(e).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);
  if(JSON.stringify(current)!==JSON.stringify(urls)||![bg,piece,knob,track].every(painted))return null;
  const dragState = readJtDragState();
  if (!dragState || dragState.generation !== initial.generation) return null;
  return { signature, generation: dragState.generation, background:{width:canvas.width,height:canvas.height,data:rgba},
    piece:{width:crop.width,height:crop.height,data:alpha},
    geometry:{scale,startX:(p.x-b.x)*scale,expectedY:(p.y-b.y)*scale,knob:k,track:t,piece:p,background:b} };
}

export function locateJtSlider(challenge) {
  const {background:b,piece:p,geometry:g}=challenge;
  const n=p.width*p.height,mask=new Uint8Array(n);let area=0;
  for(let i=0;i<n;i++)area+=mask[i]=p.data[i*4+3]>180?1:0;
  if(area<150||area>n*.92)return {ok:false,reason:'unsupported_alpha'};
  const gray=new Uint8Array(b.width*b.height);
  for(let i=0;i<gray.length;i++)gray[i]=.299*b.data[i*4]+.587*b.data[i*4+1]+.114*b.data[i*4+2];
  const stride=b.width+1,runs=[];
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;){if(!mask[y*p.width+x]){x++;continue;}const left=x;while(x<p.width&&mask[y*p.width+x])x++;runs.push([y*stride+left,y*stride+x]);}
  const mean=area/n,varA=area*(1-mean),candidates=[];
  const left=Math.max(0,Math.ceil(g.startX+8*g.scale));
  for(const threshold of [40,70,100,130,160,190,220]){
    const rows=new Uint32Array(stride*b.height),integral=new Uint32Array(stride*(b.height+1));
    for(let y=0;y<b.height;y++){let sum=0;for(let x=0;x<b.width;x++){sum+=gray[y*b.width+x]<threshold?1:0;rows[y*stride+x+1]=sum;integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+sum;}}
    for(let y=Math.max(0,Math.round(g.expectedY)-3);y<=Math.min(b.height-p.height,Math.round(g.expectedY)+3);y++){
      for(let x=left;x<=b.width-p.width;x++){
        const origin=y*stride+x,bottom=origin+p.height*stride;
        const sumB=integral[bottom+p.width]-integral[bottom]-integral[origin+p.width]+integral[origin];
        const varB=sumB*(1-sumB/n);if(varB<=0)continue;
        let both=0;for(const [l,r]of runs)both+=rows[origin+r]-rows[origin+l];
        candidates.push({x,y,threshold,score:(both-sumB*mean)/Math.sqrt(varA*varB)});
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0];if(!best)return {ok:false,reason:'no_candidate'};
  const other=candidates.find(c=>Math.abs(c.x-best.x)>p.width/3);
  const margin=best.score-(other?.score??0);
  // A dark cutout preserves the photograph's texture. Correlation on the
  // opaque interior is independent of the silhouette's binary-dark match.
  const points=[];let sumA=0,sumAA=0;
  for(let y=4;y<p.height-4;y+=2)for(let x=4;x<p.width-4;x+=2){
    if(![[0,0],[-4,0],[4,0],[0,-4],[0,4]].every(([dx,dy])=>p.data[((y+dy)*p.width+x+dx)*4+3]>240))continue;
    const i=(y*p.width+x)*4,a=.299*p.data[i]+.587*p.data[i+1]+.114*p.data[i+2];
    points.push([x,y,a]);sumA+=a;sumAA+=a*a;
  }
  const texture=[];
  if(points.length>=100)for(let y=Math.max(0,Math.round(g.expectedY)-3);y<=Math.min(b.height-p.height,Math.round(g.expectedY)+3);y++)for(let x=left;x<=b.width-p.width;x++){
    let sumB=0,sumBB=0,sumAB=0;
    for(const [dx,dy,a]of points){const v=gray[(y+dy)*b.width+x+dx];sumB+=v;sumBB+=v*v;sumAB+=a*v;}
    const den=Math.sqrt((sumAA-sumA*sumA/points.length)*(sumBB-sumB*sumB/points.length));
    texture.push({x,y,score:den>0?(sumAB-sumA*sumB/points.length)/den:0});
  }
  texture.sort((a,b)=>b.score-a.score);
  const tex=texture[0],runner=tex&&texture.find(c=>Math.abs(c.x-tex.x)>p.width/3);
  const textureMargin=tex?tex.score-(runner?.score??0):0;
  const agreement=tex&&Math.abs(tex.x-best.x)<=5&&Math.abs(tex.y-best.y)<=3;
  // Repeated scenery can make texture alone ambiguous. Agreement is mandatory;
  // either the texture separates alternatives or the silhouette does so while
  // the texture is nearly exact. Both ambiguous signals still abstain.
  const textureUnique=tex?.score>=.85&&textureMargin>=.12&&best.score>=.4&&margin>=.08;
  const shapeUnique=tex?.score>=.97&&best.score>=.65&&margin>=.20;
  const supported=agreement&&(textureUnique||shapeUnique);
  const distance=((tex?.x??best.x)-g.startX)/g.scale;
  const remaining=g.track.x+g.track.width-g.knob.x-g.knob.width;
  return {ok:Boolean(supported&&distance>=8&&distance<=remaining),
    method:textureUnique?'texture_unique':shapeUnique?'shape_unique':'ambiguous',
    shape:best,shapeMargin:margin,texture:tex,textureMargin,distance,remaining,
    start:{x:g.knob.x+g.knob.width/2,y:g.knob.y+g.knob.height/2}};
}
