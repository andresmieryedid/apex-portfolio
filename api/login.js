export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};

  let users;
  try {
    users = JSON.parse(process.env.USERS || '[]');
  } catch (e) {
    console.error('USERS env parse error:', e.message, 'Raw:', process.env.USERS);
    return res.status(500).json({ error: 'Server config error', detail: e.message });
  }

  const user = users.find(u => u.email === email && u.password === password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = Buffer.from(JSON.stringify({
    email: user.email,
    role: user.role || 'viewer',
    portfolios: user.portfolios || [],
  })).toString('base64');

  return res.status(200).json({
    token,
    role: user.role || 'viewer',
    portfolios: user.portfolios || [],
    email: user.email,
  });
}
