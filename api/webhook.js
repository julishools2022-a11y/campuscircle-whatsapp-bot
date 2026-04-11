const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

// ── Clients ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── WhatsApp sender ───────────────────────────────────────────────────────────
async function sendMessage(to, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  return res.json();
}

// ── Groq intent extractor ─────────────────────────────────────────────────────
async function extractIntent(userMessage) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `You are a resource assistant for Campus Circle — an academic platform for UNIZIK (Nnamdi Azikiwe University) students.

Extract the level and resource keywords from the student's message.
Respond ONLY in valid JSON with no extra text:
{"level":"300","keywords":"social stratification lecture note"}

Level must be one of: 100, 200, 300, 400, 500
Keywords should be the most important words from the request to search by title.

If the message is NOT a resource request, respond: {"intent":"other","message":"<a helpful reply>"}`,
        },
        { role: 'user', content: userMessage },
      ],
    });

    const raw = response.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch {
    return { intent: 'other', message: null };
  }
}

// ── Resource lookup ───────────────────────────────────────────────────────────
async function findResource(intent) {
  const keywords = intent.keywords || '';
  const level = intent.level ? `${intent.level}L` : null;

  let query = supabase
    .from('academic_resources')
    .select('id, title, file_url, is_paid, softcopy_price, level')
    .ilike('title', `%${keywords}%`)
    .limit(3);

  if (level) query = query.eq('level', level);

  const { data, error } = await query;

  // Fallback without level filter
  if ((error || !data?.length) && level) {
    const { data: data2, error: error2 } = await supabase
      .from('academic_resources')
      .select('id, title, file_url, is_paid, softcopy_price, level')
      .ilike('title', `%${keywords}%`)
      .limit(3);

    if (error2 || !data2?.length) return null;
    return data2;
  }

  if (error || !data?.length) return null;
  return data;
}

// ── List resources by level ───────────────────────────────────────────────────
async function listResources(intent) {
  const level = intent.level ? `${intent.level}L` : null;

  let query = supabase
    .from('academic_resources')
    .select('id, title, softcopy_price, is_paid, level, file_url')
    .order('title', { ascending: true })
    .limit(10);

  if (level) query = query.eq('level', level);

  const { data, error } = await query;
  if (error || !data?.length) return null;
  return data;
}

// ── Paystack link generator ───────────────────────────────────────────────────
async function generatePaystackLink(resource, phone) {
  try {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: resource.softcopy_price * 100,
        currency: 'NGN',
        reference: `cc_wa_${resource.id}_${Date.now()}`,
        metadata: {
          resource_id: resource.id,
          whatsapp_phone: phone,
          file_url: resource.file_url,
        },
      }),
    });
    const data = await res.json();
    return data?.data?.authorization_url || null;
  } catch {
    return null;
  }
}

// ── Send resource to student ──────────────────────────────────────────────────
async function sendResource(phone, resource) {
  const isPaid = resource.is_paid === 'true' || resource.is_paid === true;

  if (!isPaid) {
    return sendMessage(
      phone,
      `✅ *${resource.title}* (${resource.level})\n\nHere's your resource:\n${resource.file_url}\n\n📌 For more materials visit campuscircles.vercel.app`
    );
  }

  const payLink = await generatePaystackLink(resource, phone);
  if (!payLink) {
    return sendMessage(
      phone,
      `⚠️ Payment link failed. Please get this resource directly on the site:\ncampuscircles.vercel.app`
    );
  }

  return sendMessage(
    phone,
    `📄 *${resource.title}* (${resource.level})\n\n💳 This resource costs *₦${resource.softcopy_price}*\n\nPay securely here:\n${payLink}\n\nYou will receive the Drive link immediately after payment ✅`
  );
}

// ── Save session ──────────────────────────────────────────────────────────────
async function saveSession(phone, resources) {
  await supabase.from('whatsapp_sessions').upsert({
    phone,
    options: JSON.stringify(resources),
    updated_at: new Date().toISOString(),
  });
}

// ── Handle numbered follow-up ─────────────────────────────────────────────────
async function handleNumberedReply(phone, text) {
  const num = parseInt(text.trim());
  if (isNaN(num)) return false;

  const { data } = await supabase
    .from('whatsapp_sessions')
    .select('options')
    .eq('phone', phone)
    .single();

  if (!data?.options) return false;

  const options = JSON.parse(data.options);
  const resource = options[num - 1];
  if (!resource) return false;

  await sendResource(phone, resource);
  await supabase.from('whatsapp_sessions').delete().eq('phone', phone);
  return true;
}

// ── Main message handler ──────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  const lower = text.toLowerCase().trim();

  // Welcome
  if (lower === 'hi' || lower === 'hello' || lower === 'start') {
    return sendMessage(
      phone,
      `👋 Welcome to *Campus Circle*!\n\nYour academic resource assistant for UNIZIK.\n\n📚 *Find a resource:*\nJust tell me what you need\n_"Social stratification lecture note"_\n_"300 level political sociology"_\n\n📋 *Browse by level:*\nType _"list 300 level"_ to see all available\n\n🌐 Full platform: campuscircles.vercel.app\n\nType *help* for more options.`
    );
  }

  // Help
  if (lower === 'help') {
    return sendMessage(
      phone,
      `ℹ️ *Campus Circle Help*\n\n📚 *Find a resource:*\nJust describe what you need\n_"Social stratification lecture note"_\n\n📋 *List resources:*\n_"list 300 level"_\n_"show 200 level resources"_\n_"available 100 level"_\n\n🌐 *Visit site:* campuscircles.vercel.app\n\n📩 *Support:* Describe your issue and we'll help.`
    );
  }

  // List resources
  if (
    lower.includes('list') ||
    lower.includes('available') ||
    lower.includes('show all') ||
    lower.includes('show me') ||
    (lower.includes('show') && lower.includes('level'))
  ) {
    const intent = await extractIntent(text);
    const resources = await listResources(intent);

    if (!resources) {
      return sendMessage(
        phone,
        `😔 No resources found${intent.level ? ` for ${intent.level}L` : ''} yet.\n\nVisit *campuscircles.vercel.app* to browse all materials.`
      );
    }

    const level = intent.level ? `${intent.level}L` : 'All Levels';
    let msg = `📚 *Available Resources — ${level}:*\n\n`;
    resources.forEach((r, i) => {
      const paid = r.is_paid === 'true' || r.is_paid === true;
      msg += `${i + 1}. ${r.title}\n    ${paid ? `₦${r.softcopy_price}` : 'Free'}\n\n`;
    });
    msg += `Reply with the number to get any resource.\nE.g. _"1"_`;

    await saveSession(phone, resources);
    return sendMessage(phone, msg);
  }

  // AI intent extraction
  const intent = await extractIntent(text);

  if (intent.intent === 'other') {
    const reply =
      intent.message ||
      `I'm here to help you find academic resources 📚\n\nTry:\n• _"Social stratification lecture note"_\n• _"list 300 level resources"_\n\nOr visit campuscircles.vercel.app`;
    return sendMessage(phone, reply);
  }

  // Search resources
  const resources = await findResource(intent);

  if (!resources) {
    return sendMessage(
      phone,
      `😔 I couldn't find that resource.\n\nTry:\n• Rephrasing your request\n• _"list ${intent.level || '300'} level"_ to browse all available\n• Visit *campuscircles.vercel.app*`
    );
  }

  // Multiple results
  if (resources.length > 1) {
    let msg = `📚 I found ${resources.length} resources:\n\n`;
    resources.forEach((r, i) => {
      const paid = r.is_paid === 'true' || r.is_paid === true;
      msg += `${i + 1}. *${r.title}* (${r.level})\n    ${paid ? `₦${r.softcopy_price}` : 'Free'}\n\n`;
    });
    msg += `Reply with the number to get it. E.g. _"1"_`;

    await saveSession(phone, resources);
    return sendMessage(phone, msg);
  }

  // Single result
  return sendResource(phone, resources[0]);
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages?.length) return res.status(200).send('OK');

      const msg = messages[0];
      const phone = msg.from;
      const text = msg.text?.body;

      if (!text) return res.status(200).send('OK');

      const handled = await handleNumberedReply(phone, text);
      if (!handled) await handleMessage(phone, text);

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Method not allowed');
};
