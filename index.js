const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ══ CONFIG ══
const TG_TOKEN = process.env.TG_TOKEN;
const TG_ADMIN = process.env.TG_ADMIN;
const TG_ALLOWED = JSON.parse(process.env.TG_ALLOWED || '{}');

// ══ Firebase Init ══
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ══ إرسال رسالة ══
async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ══ معالجة الأوامر ══
async function handleCommand(chatId, text, role) {
  const cmd = text.split(' ')[0].toLowerCase();
  const arg = text.slice(cmd.length).trim();

  if (cmd === '/start' || cmd === '/help') {
    await tgSend(chatId, [
      '📋 <b>أوامر نظام التقنين:</b>',
      '',
      '/stats — إحصائيات سريعة',
      '/late — قائمة المتأخرين',
      '/today — نشاط اليوم',
      '/report — تقرير أسبوعي',
      '/search [اسم أو رقم] — بحث',
      '',
      role === 'admin' || role === 'supervisor' ? '/complete [رقم قومي] — تغيير لمكتمل\n/addnote [رقم قومي] [ملاحظة]' : ''
    ].join('\n'));
    return;
  }

  if (cmd === '/stats') {
    const snap = await db.collection('records').get();
    const records = snap.docs.map(d => d.data());
    const total = records.length;
    const complete = records.filter(r => r.status === 'complete').length;
    const tqonly = records.filter(r => r.status === 'tqonly').length;
    const pending = records.filter(r => r.status === 'pending').length;
    const pct = total ? Math.round(complete / total * 100) : 0;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const late = records.filter(r => r.adddate && new Date(r.adddate) < cutoff && r.status !== 'complete');
    await tgSend(chatId, [
      '📊 <b>إحصائيات نظام التقنين</b>',
      '━━━━━━━━━━━━━━',
      `📁 إجمالي: <b>${total}</b>`,
      `✅ مكتمل: <b>${complete}</b>`,
      `🔢 تقنين فقط: <b>${tqonly}</b>`,
      `⏳ ناقص: <b>${pending}</b>`,
      `⚠️ متأخر: <b>${late.length}</b>`,
      `📈 نسبة الإنجاز: <b>${pct}%</b>`
    ].join('\n'));
    return;
  }

  if (cmd === '/late') {
    const snap = await db.collection('records').get();
    const records = snap.docs.map(d => d.data());
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const late = records.filter(r => r.adddate && new Date(r.adddate) < cutoff && r.status !== 'complete');
    if (!late.length) { await tgSend(chatId, '✅ لا يوجد متأخرون'); return; }
    const lines = [`⚠️ <b>المتأخرون (${late.length})</b>\n`];
    late.slice(0, 10).forEach((r, i) => {
      const days = Math.floor((new Date() - new Date(r.adddate)) / 86400000);
      lines.push(`${i + 1}. ${r.name} — <b>${days} يوم</b>`);
    });
    if (late.length > 10) lines.push(`\n... و ${late.length - 10} آخرين`);
    await tgSend(chatId, lines.join('\n'));
    return;
  }

  if (cmd === '/today') {
    const today = new Date().toISOString().split('T')[0];
    const snap = await db.collection('records').where('adddate', '==', today).get();
    const recs = snap.docs.map(d => d.data());
    if (!recs.length) { await tgSend(chatId, '📅 لا توجد إضافات اليوم'); return; }
    const lines = [`📅 <b>نشاط اليوم (${recs.length})</b>\n`];
    recs.slice(0, 10).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name} — ${r.status === 'complete' ? '✅' : '⏳'}`);
    });
    await tgSend(chatId, lines.join('\n'));
    return;
  }

  if (cmd === '/search') {
    const snap = await db.collection('records').get();
    const records = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
    if (!arg) {
      const recent = records.slice(0, 5);
      const lines = ['📋 <b>آخر 5 سجلات:</b>\n'];
      recent.forEach((r, i) => {
        lines.push(`${i + 1}. <b>${r.name}</b>`);
        lines.push(`   🪪 ${r.natid || '—'} | 📞 ${r.tel1 || '—'}`);
      });
      lines.push('\n💡 /search [اسم أو رقم قومي]');
      await tgSend(chatId, lines.join('\n'));
      return;
    }
    const q = arg.toLowerCase();
    const found = records.filter(r =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.natid || '').includes(q) ||
      (r.newtq || '').includes(q)
    );
    if (!found.length) { await tgSend(chatId, `🔍 لا توجد نتائج لـ: ${arg}`); return; }
    const lines = [`🔍 <b>نتائج (${found.length})</b>\n`];
    found.slice(0, 5).forEach((r, i) => {
      const st = r.status === 'complete' ? '✅' : r.status === 'tqonly' ? '🔢' : '⏳';
      lines.push(`${i + 1}. <b>${r.name}</b> ${st}`);
      lines.push(`   🪪 ${r.natid || '—'}`);
      lines.push(`   📞 ${r.tel1 || '—'}`);
      lines.push(`   🏘️ ${r.address || '—'}`);
      lines.push(`   🔢 ${r.newtq || '—'} | 📐 ${r.anum || '—'}`);
      if (i < Math.min(found.length, 5) - 1) lines.push('');
    });
    await tgSend(chatId, lines.join('\n'));
    return;
  }

  if (cmd === '/complete' && (role === 'admin' || role === 'supervisor') && arg) {
    const snap = await db.collection('records').get();
    const rec = snap.docs.find(d => (d.data().natid || '').includes(arg) || (d.data().name || '').toLowerCase().includes(arg.toLowerCase()));
    if (!rec) { await tgSend(chatId, `❌ لم يتم إيجاد: ${arg}`); return; }
    await rec.ref.update({ status: 'complete', updatedAt: new Date().toISOString() });
    await tgSend(chatId, `✅ تم تغيير حالة <b>${rec.data().name}</b> إلى مكتمل`);
    return;
  }

  if (cmd === '/report') {
    const snap = await db.collection('records').get();
    const records = snap.docs.map(d => d.data());
    const t = records.length, c = records.filter(r => r.status === 'complete').length;
    const tq = records.filter(r => r.status === 'tqonly').length;
    const p = records.filter(r => r.status === 'pending').length;
    const pct = t ? Math.round(c / t * 100) : 0;
    const wk = new Date(); wk.setDate(wk.getDate() - 7);
    const wkR = records.filter(r => r.adddate && new Date(r.adddate) >= wk);
    await tgSend(chatId, [
      '📄 <b>التقرير الأسبوعي</b>',
      '━━━━━━━━━━━━━━',
      `📁 إجمالي: <b>${t}</b>`,
      `✅ مكتمل: <b>${c}</b> (${pct}%)`,
      `🔢 تقنين فقط: <b>${tq}</b>`,
      `⏳ ناقص: <b>${p}</b>`,
      `📅 مضاف هذا الأسبوع: <b>${wkR.length}</b>`
    ].join('\n'));
    return;
  }

  await tgSend(chatId, '❓ أمر غير معروف. ابعت /help');
}

// ══ Webhook endpoint ══
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    if (!TG_ALLOWED[chatId]) {
      await tgSend(chatId, `🚫 غير مصرح لك.\n\n📧 Chat ID بتاعك: <code>${chatId}</code>`);
      return;
    }
    await handleCommand(chatId, text, TG_ALLOWED[chatId].role);
  } catch (e) {
    console.error('webhook error:', e);
  }
});

// ══ Health check ══
app.get('/', (req, res) => res.send('🤖 Taqneen Bot is running!'));

// ══ Start server ══
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot running on port ${PORT}`);
  // Set webhook
  const url = process.env.RENDER_URL;
  if (url) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook?url=${url}/webhook`);
    console.log('Webhook set:', url);
  }
});
