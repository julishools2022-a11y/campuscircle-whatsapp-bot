const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

// ── Clients ──────────────────────────────────────────────────────────────────
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

Extract the department code, level, and resource type from the student's message.
Respond ONLY in valid JSON with no extra text:
{"department":"SOC","level":"300","resource_type":"past questions"}

Department codes: SOC, PSC, ECO, LAW, ENG, MED, PHY, CHM, BIO, MTH, CSC, BUS, ACC, MKT, PUB, MAS, REL, HIS, GEO, ARC, CVE, ELE, MEC
Resource types: past questions, lecture notes, textbook, assignment, handout
Level: 100, 200, 300, 400, 500

If unsure about any field, use null.
If the message is NOT a resource request, respond: {"intent":"other","message":"<your reply>"}`,
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
  let query = supabase
    .from('academic_resources')
    .select('id, title, file_url, is_paid, price, department, level')
    .limit(3);

  if (intent.department) query = query.ilike('department', intent.department);
  if (intent.level) query = query.ilike('level', `%${intent.level}%`);
  if (intent.resource_type)
    query = query.ilike('title', `%${intent.resource_type}%`);

  const { data, error } = await query;
  if (error || !data?.length) return null;
  return data;
}

// ── Paystack link generator ───────────────────────────────────────────────────
async function generatePaystackLink(resource, phone) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: resource.price * 100, // kobo
      currency: 'NGN',
      reference: `cc_wa_${resource.id}_${Date.now()}`,
      metadata: {
        resource_id: resource.id,
        whatsapp_phone: phone,
        file_url: resource.drive_link,
      },
      callback_url: `${process.env.BASE_URL}/api/payment-callback`,
    }),
  });
  const data = await res.json();
  return data?.data?.authorization_url || null;
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  const lower = text.toLowerCase().trim();

  // Commands
  if (lower === 'hi' || lower === 'hello' || lower === 'start') {
    return sendMessage(
      phone,
      `👋 Welcome to *Campus Circle*!\n\nYour academic resource assistant for UNIZIK.\n\n📚 Just tell me what you need. Examples:\n• _"SOC 309 past questions"_\n• _"300 level economics lecture notes"_\n• _"ENG 201 handout"_\n\n🌐 Full platform: campuscircle.name.ng\n\nType *help* anytime for more options.`
    );
  }

  if (lower === 'help') {
    return sendMessage(
      phone,
      `ℹ️ *Campus Circle Help*\n\n📚 *Find a resource:* Just describe what you need\nE.g. _"SOC 309 past questions"_\n\n🌐 *Visit site:* campuscircle.name.ng\n\n📩 *Support:* Reply with your issue and we'll help you.`
    );
  }

  // AI intent extraction
  const intent = await extractIntent(text);

  if (intent.intent === 'other') {
    const reply =
      intent.message ||
      "I'm here to help you find academic resources 📚\n\nTry something like: _\"SOC 309 past questions\"_ or visit campuscircles.vercel.app";
    return sendMessage(phone, reply);
  }

  // Resource search
  const resources = await findResource(intent);

  if (!resources) {
    return sendMessage(
      phone,
      `😔 I couldn't find that resource right now.\n\nTry rephrasing or visit *campuscircles.vercel.app* to browse all materials.\n\nYou can also describe it differently — e.g. include the course code.`
    );
  }

  // If multiple results
  if (resources.length > 1) {
    let msg = `📚 I found ${resources.length} resources:\n\n`;
    resources.forEach((r, i) => {
      msg += `${i + 1}. *${r.title}*${r.is_paid ? ` — ₦${r.price}` : ' — Free'}\n`;
    });
    msg += `\nReply with the number to get it. E.g. _"1"_`;

    // Store options temporarily in Supabase for follow-up
    await supabase.from('whatsapp_sessions').upsert({
      phone,
      options: JSON.stringify(resources),
      updated_at: new Date().toISOString(),
    });

    return sendMessage(phone, msg);
  }

  // Single result
  const resource = resources[0];

  if (!resource.is_paid) {
    return sendMessage(
      phone,
      `✅ *${resource.title}*\n\nHere's your resource:\n${resource.file_url}\n\n📌 For more materials visit campuscircle.name.ng`
    );
  }

  // Paid resource
  const payLink = await generatePaystackLink(resource, phone);
  if (!payLink) {
    return sendMessage(phone, `⚠️ Payment link failed. Please try via the site: campuscircles.vercel.app`);
  }

  return sendMessage(
    phone,
    `📄 *${resource.title}*\n\n💳 This resource costs *₦${resource.price}*\n\nPay securely here:\n${payLink}\n\nYou'll receive the Drive link immediately after payment ✅`
  );
}

// ── Handle numbered follow-up (1, 2, 3) ──────────────────────────────────────
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

  if (!resource.is_paid) {
    await sendMessage(
      phone,
      `✅ *${resource.title}*\n\nHere's your resource:\n${resource.file_url}\n\n📌 For more materials visit campuscircle.name.ng`
    );
  } else {
    const payLink = await generatePaystackLink(resource, phone);
    await sendMessage(
      phone,
      `📄 *${resource.title}*\n\n💳 This resource costs *₦${resource.price}*\n\nPay securely here:\n${payLink}\n\nYou'll receive the Drive link immediately after payment ✅`
    );
  }

  // Clear session
  await supabase.from('whatsapp_sessions').delete().eq('phone', phone);
  return true;
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Webhook verification (one-time setup)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Incoming messages
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

      // Check numbered reply first
      const handled = await handleNumberedReply(phone, text);
      if (!handled) await handleMessage(phone, text);

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(200).send('OK'); // Always 200 to WhatsApp
    }
  }

  return res.status(405).send('Method not allowed');
}
