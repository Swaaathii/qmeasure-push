const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const COL = db.collection('qmeasure_data');

const IST = 330 * 60000;              // India time (UTC+5:30)
const TARGET_MS = 9 * 3600000;        // 9-hour workday
const FOLLOWUP_HOUR = 9;              // follow-up alerts start at 9 AM IST
const now = Date.now();
const ist = new Date(now + IST);
const today = ist.toISOString().slice(0, 10);
const hourIST = ist.getUTCHours();
const dayStart = Date.parse(today + 'T00:00:00+05:30');

async function read(key, fallback){
  const d = await COL.doc(key).get();
  if(!d.exists) return fallback;
  try { return JSON.parse(d.data().value); } catch(e){ return fallback; }
}

async function main(){
  const [att, leads, visits, sent] = await Promise.all([
    read('attendance-log', []), read('crm-leads', []), read('crm-visits', []), read('push-sent', {})
  ]);

  // Load every employee's push tokens
  const snap = await COL.where(admin.firestore.FieldPath.documentId(), '>=', 'push-')
                        .where(admin.firestore.FieldPath.documentId(), '<', 'push.').get();
  const users = {}; // name -> { docId, tokens, delay }
  snap.forEach(doc => {
    if(doc.id === 'push-sent') return;
    try {
      const rec = JSON.parse(doc.data().value);
      if(rec && rec.name && (rec.tokens || []).length) users[rec.name] = { docId: doc.id, tokens: rec.tokens, delay: Number(rec.delay) || 30, rec };
    } catch(e){}
  });

  const jobs = []; // { name, title, body, tag, url, sentKey }

  // 1) Checkout time (9h worked and still checked in)
  for(const name of Object.keys(users)){
    const recs = att.filter(r => r.name === name && r.timestamp >= dayStart).sort((a,b) => a.timestamp - b.timestamp);
    if(!recs.length) continue;
    let ms = 0, openIn = null;
    recs.forEach(r => {
      if(r.type === 'in') openIn = r.timestamp;
      else if(r.type === 'out' && openIn !== null){ ms += r.timestamp - openIn; openIn = null; }
    });
    if(openIn === null) continue;               // already checked out
    ms += now - openIn;
    if(ms >= TARGET_MS) jobs.push({ name, title: '⏰ Time to check out', body: "You've completed your 9 working hours. Don't forget to check out.", tag: 'checkout', sentKey: 'checkout:' + name + ':' + today });
  }

  // 2) Follow-up due + 3) Revisit due
  for(const lead of leads){
    const owner = lead.createdBy;
    if(!owner || !users[owner]) continue;
    const status = lead.status || ({ Won: 'Closed-Won', Lost: 'Closed-Lost' }[lead.stage] || lead.stage || 'New');
    const closed = ['Closed-Won', 'Closed-Lost'].includes(status);
    const label = lead.company || lead.name || 'a lead';

    if(!closed && lead.followUpDate && hourIST >= FOLLOWUP_HOUR){
      const daysLate = Math.round((Date.parse(today) - Date.parse(lead.followUpDate)) / 86400000);
      if(daysLate >= 0 && daysLate <= 3){
        jobs.push({ name: owner, title: daysLate === 0 ? '📞 Follow-up due today' : '⚠️ Follow-up overdue',
          body: 'Follow up with ' + label + (lead.nextAction ? ' — ' + lead.nextAction : '') + '.', tag: 'followup-' + lead.id,
          url: './', sentKey: 'followup:' + lead.id + ':' + today });
      }
    }
    if(lead.revisitAt && !lead.revisitNotifiedAt){
      const s = String(lead.revisitAt);
      const ts = Date.parse(s.length === 16 ? s + ':00+05:30' : s);
      if(ts && ts <= now && now - ts < 24 * 3600000){
        jobs.push({ name: owner, title: '🔁 Revisit due', body: 'Time to revisit ' + label + '.', tag: 'revisit-' + lead.id,
          sentKey: 'revisit:' + lead.id + ':' + lead.revisitAt });
      }
    }
  }

  // 4) Open visit — "Are you still at the visit?" (repeats every delay until checkout)
  const repeatJobs = [];
  for(const v of visits){
    if(v.checkOutAt || !users[v.salesperson]) continue;
    if(now - v.checkInAt > 16 * 3600000) continue;     // stop nagging on stale visits
    const delay = users[v.salesperson].delay * 60000;
    const key = 'visit:' + v.id;
    const last = sent[key] || 0;
    const base = Number(v.reminderSnoozeUntil) || (v.checkInAt + delay);
    const next = Math.max(base, last ? last + delay : 0);
    if(now >= next){
      const lead = leads.find(l => l.id === v.leadId);
      const mins = Math.max(1, Math.floor((now - v.checkInAt) / 60000));
      repeatJobs.push({ name: v.salesperson, title: '📍 Are you still at the visit?',
        body: "You've been checked in for " + mins + ' min' + (lead ? ' at ' + (lead.company || lead.name) : '') + '. Forgot to check out?',
        tag: 'visit-' + v.id, sentKey: key });
    }
  }

  // Send
  const all = jobs.filter(j => !sent[j.sentKey]).concat(repeatJobs);
  for(const j of all){
    const u = users[j.name];
    const res = await admin.messaging().sendEachForTokens({
      tokens: u.tokens,
      data: { title: j.title, body: j.body, tag: j.tag, url: j.url || './' },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });
    const dead = [];
    res.responses.forEach((r, i) => {
      if(!r.success && r.error && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error.code || '')) dead.push(u.tokens[i]);
    });
    if(dead.length){
      u.rec.tokens = u.rec.tokens.filter(t => !dead.includes(t));
      u.tokens = u.rec.tokens;
      await COL.doc(u.docId).set({ value: JSON.stringify(u.rec) });
    }
    sent[j.sentKey] = now;
    console.log('Sent to', j.name, '-', j.title, '(ok:', res.successCount + ')');
  }

  // Prune old dedupe entries and save
  Object.keys(sent).forEach(k => { if(now - sent[k] > 3 * 86400000) delete sent[k]; });
  if(all.length) await COL.doc('push-sent').set({ value: JSON.stringify(sent) });
  console.log('Done. Notifications sent:', all.length);
}

main().catch(e => { console.error(e); process.exit(1); });
