const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

// ── Clients ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Admin numbers ─────────────────────────────────────────────────────────────
const ADMIN_NUMBERS = [
  process.env.ADMIN_PHONE_1,
  process.env.ADMIN_PHONE_2,
  process.env.ADMIN_PHONE_3,
].filter(Boolean);

const CAMPUS_CIRCLE_KNOWLEDGE = `
You are the official AI assistant for Campus Circle — Your Ultimate Academic Success Partner.

ABOUT CAMPUS CIRCLE:
Campus Circle is a digital academic platform built specifically for UNIZIK (Nnamdi Azikiwe University) students. It digitizes the campus library experience so students can focus on studying smarter, passing exams, and achieving academic excellence.

KEY FEATURES:
1. Complete Lecture Notes — Comprehensive, well-structured notes so students never miss important points taught in class.
2. Digital Library — Instantly unlock and read soft copy PDFs of faculty and departmental handouts, textbooks, and past questions right from your phone.
3. Hardcopy Delivery — Order printed materials and get them delivered straight to your hostel or the campus gate.
4. Instant Alerts — Real-time notifications when new study materials for your department are uploaded.
5. AI Study Companion — An AI assistant that helps students understand course content and prepare for exams.
6. CBT Quiz Practice — Practice mode to prepare for computer-based tests.

WHY CAMPUS CIRCLE:
- Verified and trusted platform
- Covers all UNIZIK faculties and departments
- Safe, secure and student-focused
- Bringing innovation to student learning

WEBSITE: campuscircles.vercel.app

HOW TO GET STARTED:
1. Visit campuscircles.vercel.app
2. Create a free account
3. Browse resources by department and level
4. Purchase softcopy or order hardcopy delivery

SUPPORT:
- For missing resources, report via this chat
- For payment issues, contact support via the site
- For general questions, ask this assistant anytime

YOUR ROLE:
- Help students find academic resources
- Answer any question about Campus Circle
- Answer general academic questions to help students study
- Be friendly, helpful and speak like a knowledgeable campus companion
- Always encourage students to visit campuscircles.vercel.app for full access
- If asked about a specific resource, check availability and send the site link
- Never make up resource information — only confirm what exists in the database
`;

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

// ── Send email via Resend ─────────────────────────────────────────────────────
async function sendEmail(subject, body) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Campus Circle Bot <bot@campuscircle.ng>',
        to: [process.env.ADMIN_EMAIL || 'campuscircle@gmail.com'],
        subject,
        text: body,
      }),
    });
  } catch (err) {
    console.error('Email error:', err);
  }
}

// ── Get or create bot user ────────────────────────────────────────────────────
async function getUser(phone) {
  const { data } = await supabase
    .from('bot_users')
    .select('*')
    .eq('phone', phone)
    .single();
  return data || null;
}

async function createUser(phone, name, email) {
  const { data } = await supabase
    .from('bot_users')
    .upsert({ phone, full_name: name, email, is_admin: false })
    .select()
    .single();
  return data;
}

// ── Track all users for broadcast ─────────────────────────────────────────────
async function trackUser(phone) {
  await supabase
    .from('bot_users')
    .upsert({ phone, updated_at: new Date().toISOString() }, { onConflict: 'phone', ignoreDuplicates: false });
}

// ── Groq AI response ──────────────────────────────────────────────────────────
async function getAIResponse(userMessage, context = '') {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: CAMPUS_CIRCLE_KNOWLEDGE + (context ? `\n\nADDITIONAL CONTEXT:\n${context}` : ''),
        },
        { role: 'user', content: userMessage },
      ],
    });
    return response.choices[0].message.content.trim();
  } catch {
    return `I'm having trouble responding right now. Please visit campuscircles.vercel.app for assistance.`;
  }
}

// ── Extract intent ────────────────────────────────────────────────────────────
async function extractIntent(userMessage) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `You are a classifier for a UNIZIK academic resource bot.

Classify the student's message into one of these intents:
- "resource_search" — looking for a specific resource
- "resource_list" — wants to see available resources for a level
- "missing_report" — reporting a resource that doesn't exist on the platform
- "registration" — wants to register or create an account
- "my_library" — wants to see their purchased/saved resources
- "support" — has a complaint, issue or question about the platform
- "general" — general academic question or anything else

Also extract:
- level: 100, 200, 300, 400, 500 or null
- keywords: most important search words or null

Respond ONLY in valid JSON:
{"intent":"resource_search","level":"300","keywords":"social stratification lecture note"}`,
        },
        { role: 'user', content: userMessage },
      ],
    });
    const raw = response.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch {
    return { intent: 'general', level: null, keywords: null };
  }
}

// ── Resource lookup ───────────────────────────────────────────────────────────
async function findResource(keywords, level) {
  const levelStr = level ? `${level}L` : null;

  let query = supabase
    .from('academic_resources')
    .select('id, title, level, department')
    .ilike('title', `%${keywords}%`)
    .limit(3);

  if (levelStr) query = query.eq('level', levelStr);

  const { data, error } = await query;

  if ((error || !data?.length) && levelStr) {
    const { data: data2 } = await supabase
      .from('academic_resources')
      .select('id, title, level, department')
      .ilike('title', `%${keywords}%`)
      .limit(3);
    return data2?.length ? data2 : null;
  }

  return data?.length ? data : null;
}

// ── List resources ────────────────────────────────────────────────────────────
async function listResources(level) {
  const levelStr = level ? `${level}L` : null;

  let query = supabase
    .from('academic_resources')
    .select('id, title, level, softcopy_price, is_paid')
    .order('title', { ascending: true })
    .limit(10);

  if (levelStr) query = query.eq('level', levelStr);

  const { data, error } = await query;
  return error || !data?.length ? null : data;
}

// ── Save session ──────────────────────────────────────────────────────────────
async function saveSession(phone, data) {
  await supabase.from('whatsapp_sessions').upsert({
    phone,
    options: JSON.stringify(data),
    updated_at: new Date().toISOString(),
  });
}

async function getSession(phone) {
  const { data } = await supabase
    .from('whatsapp_sessions')
    .select('options')
    .eq('phone', phone)
    .single();
  return data?.options ? JSON.parse(data.options) : null;
}

async function clearSession(phone) {
  await supabase.from('whatsapp_sessions').delete().eq('phone', phone);
}

// ── Handle numbered reply ─────────────────────────────────────────────────────
async function handleNumberedReply(phone, text) {
  const num = parseInt(text.trim());
  if (isNaN(num)) return false;

  const session = await getSession(phone);
  if (!session) return false;

  // Registration flow
  if (session.step) return false;

  const resource = session[num - 1];
  if (!resource) return false;

  await sendMessage(
    phone,
    `✅ *${resource.title}* (${resource.level})\n\nGet access here:\ncampuscircles.vercel.app\n\n📌 Login or register to unlock this resource.`
  );

  await clearSession(phone);
  return true;
}

// ── Registration flow ─────────────────────────────────────────────────────────
async function handleRegistration(phone, text, session) {
  if (!session?.step) {
    await saveSession(phone, { step: 'name' });
    return sendMessage(phone, `👤 Let's get you registered!\n\nWhat is your *full name*?`);
  }

  if (session.step === 'name') {
    await saveSession(phone, { step: 'email', name: text });
    return sendMessage(phone, `📧 What is your *email address*?`);
  }

  if (session.step === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      return sendMessage(phone, `❌ That doesn't look like a valid email. Please enter a valid email address.`);
    }

    await createUser(phone, session.name, text);
    await clearSession(phone);

    return sendMessage(
      phone,
      `🎉 Welcome to Campus Circle, *${session.name}*!\n\nYour account is set up.\n\n🌐 Visit campuscircles.vercel.app to access your full library and all platform features.\n\nType *help* anytime to see what I can do for you!`
    );
  }
}

// ── Admin: broadcast ──────────────────────────────────────────────────────────
async function handleBroadcast(phone, text) {
  if (!ADMIN_NUMBERS.includes(phone)) {
    return sendMessage(phone, `❌ You don't have permission to use this command.`);
  }

  const message = text.replace('/broadcast', '').trim();
  if (!message) {
    return sendMessage(phone, `Usage: /broadcast Your message here`);
  }

  const { data: users } = await supabase
    .from('bot_users')
    .select('phone');

  if (!users?.length) {
    return sendMessage(phone, `No users to broadcast to yet.`);
  }

  let sent = 0;
  for (const user of users) {
    if (user.phone !== phone) {
      await sendMessage(user.phone, `📢 *Campus Circle Update*\n\n${message}`);
      sent++;
    }
  }

  return sendMessage(phone, `✅ Broadcast sent to ${sent} users.`);
}

// ── Admin: notify reporter ────────────────────────────────────────────────────
async function handleNotifyReporter(phone, text) {
  if (!ADMIN_NUMBERS.includes(phone)) {
    return sendMessage(phone, `❌ You don't have permission to use this command.`);
  }

  // Format: /notify +2348161268826 SOC 333 past questions
  const parts = text.replace('/notify', '').trim().split(' ');
  const reporterPhone = parts[0];
  const resourceName = parts.slice(1).join(' ');

  if (!reporterPhone || !resourceName) {
    return sendMessage(phone, `Usage: /notify [phone] [resource name]\nE.g: /notify 2348161268826 SOC 333 past questions`);
  }

  await sendMessage(
    reporterPhone,
    `✅ *Good news!*\n\nThe resource you reported as missing has been added:\n\n📄 *${resourceName}*\n\nGet it here:\ncampuscircles.vercel.app\n\n📌 Login to access it in your library.`
  );

  return sendMessage(phone, `✅ Reporter notified successfully.`);
}

// ── Main message handler ──────────────────────────────────────────────────────
async function handleMessage(phone, text) {
  const lower = text.toLowerCase().trim();

  // Track user
  await trackUser(phone);

  // Admin commands
  if (lower.startsWith('/broadcast')) return handleBroadcast(phone, text);
  if (lower.startsWith('/notify')) return handleNotifyReporter(phone, text);

  // Check for active registration session
  const session = await getSession(phone);
  if (session?.step) return handleRegistration(phone, text, session);

  // Welcome
  if (lower === 'hi' || lower === 'hello' || lower === 'start') {
    const user = await getUser(phone);
    const name = user?.full_name ? `, ${user.full_name.split(' ')[0]}` : '';

    return sendMessage(
      phone,
      `👋 Hello${name}! Welcome to *Campus Circle* — Your Ultimate Academic Success Partner! 🎓\n\nI'm your AI study assistant, here to help you succeed at UNIZIK.\n\n📚 *What I can do:*\n• Find lecture notes, past questions & textbooks\n• Tell you what resources are available for your level\n• Answer questions about your courses\n• Help you navigate the Campus Circle platform\n\n🌐 *Full platform:* campuscircles.vercel.app\n\n_Just tell me what you need or type *help* to see all options._`
    );
  }

  // Help
  if (lower === 'help') {
    return sendMessage(
      phone,
      `ℹ️ *Campus Circle Bot — What I Can Do*\n\n📚 *Find a resource:*\n_"SOC 333 past questions"_\n_"300 level political sociology notes"_\n\n📋 *Browse by level:*\n_"list 300 level resources"_\n_"show available 200 level"_\n\n🚨 *Report missing resource:*\n_"I can't find SOC 333 past questions"_\n\n👤 *Register:*\nType _"register"_ to create your account\n\n🤖 *Ask anything:*\n_"What is social stratification?"_\n_"How do I pay for a resource?"_\n\n🌐 *Site:* campuscircles.vercel.app`
    );
  }

  // Register
  if (lower === 'register' || lower === 'sign up' || lower === 'create account') {
    const user = await getUser(phone);
    if (user?.full_name) {
      return sendMessage(
        phone,
        `✅ You're already registered as *${user.full_name}*!\n\n🌐 Visit campuscircles.vercel.app to access your full library.`
      );
    }
    return handleRegistration(phone, text, null);
  }

  // Classify intent
  const intent = await extractIntent(text);

  // Resource list
  if (intent.intent === 'resource_list') {
    const resources = await listResources(intent.level);

    if (!resources) {
      return sendMessage(
        phone,
        `😔 No resources found${intent.level ? ` for ${intent.level}L` : ''} yet.\n\nVisit *campuscircles.vercel.app* to browse all materials or report what's missing.`
      );
    }

    const level = intent.level ? `${intent.level}L` : 'All Levels';
    let msg = `📚 *Available Resources — ${level}:*\n\n`;
    resources.forEach((r, i) => {
      const paid = r.is_paid === 'true' || r.is_paid === true;
      msg += `${i + 1}. ${r.title}\n    ${paid ? `₦${r.softcopy_price}` : 'Free'}\n\n`;
    });
    msg += `Reply with a number to get the site link.\nOr visit campuscircles.vercel.app to browse all.`;

    await saveSession(phone, resources);
    return sendMessage(phone, msg);
  }

  // Resource search
  if (intent.intent === 'resource_search' && intent.keywords) {
    const resources = await findResource(intent.keywords, intent.level);

    if (!resources) {
      return sendMessage(
        phone,
        `😔 *"${intent.keywords}"* isn't available yet.\n\nWould you like to report this as a missing resource so we can add it?\n\nReply _"yes report it"_ or visit campuscircles.vercel.app to browse what's available.`
      );
    }

    if (resources.length === 1) {
      return sendMessage(
        phone,
        `✅ Found it!\n\n📄 *${resources[0].title}* (${resources[0].level})\n\nGet access here:\ncampuscircles.vercel.app\n\n📌 Login or register to unlock this resource.`
      );
    }

    let msg = `📚 I found ${resources.length} matching resources:\n\n`;
    resources.forEach((r, i) => {
      msg += `${i + 1}. *${r.title}* (${r.level})\n\n`;
    });
    msg += `Reply with the number to get the site link.`;

    await saveSession(phone, resources);
    return sendMessage(phone, msg);
  }

  // Missing resource report
  if (
    intent.intent === 'missing_report' ||
    lower.includes('yes report it') ||
    lower.includes('report it')
  ) {
    const resourceName = intent.keywords || text;

    await sendEmail(
      `Missing Resource Report — Campus Circle Bot`,
      `A student reported a missing resource:\n\nResource: ${resourceName}\nReported by: ${phone}\nTime: ${new Date().toISOString()}\n\nPlease add this resource to the platform.\n\nTo notify the student when added, reply:\n/notify ${phone} ${resourceName}`
    );

    return sendMessage(
      phone,
      `✅ *Report received!*\n\nWe'll work on adding *"${resourceName}"* as soon as possible.\n\nYou'll get a notification here once it's available on campuscircles.vercel.app 📬`
    );
  }

  // Support or general AI response
  const aiReply = await getAIResponse(text);
  return sendMessage(phone, aiReply);
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
