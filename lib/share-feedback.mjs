// External text is feedback, never an agent command or an approval.
import { ownerShareComments, resolveShareComment } from './shares.mjs';
import { readMeta, latest, baseUrl, itemPath } from './store.mjs';
export function externalFeedbackItems(filter={}) {
  return ownerShareComments(filter).filter(c=>c.status==='open').map(c=>{
    const m=readMeta(c.project,c.slug);
    return {id:`share:${c.shareId}:${c.id}`,item:`${c.project}/${c.slug}`,title:m?.title||c.shareTitle,
      url:baseUrl()+itemPath(c.project,c.slug),v:c.version,latest:m?latest(m)?.v:c.version,file:c.file,
      text:c.text,createdAt:c.createdAt,nickname:c.nickname,external:true,untrusted:true,source:'external-share'};
  });
}
export async function resolveExternalFeedback(ids,filter={}) {
  let n=0;
  for(const c of externalFeedbackItems(filter))if(ids==='all'||ids.includes(c.id)){
    const [,shareId,cid]=c.id.split(':');await resolveShareComment(shareId,cid);n++;
  }
  return n;
}
