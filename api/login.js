export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};

  const AUTH_EMAIL = process.env.AUTH_EMAIL;
  const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

  if (email !== AUTH_EMAIL || password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = Buffer.from(JSON.stringify({
    email,
    role: 'admin',
    portfolios: [],
  })).toString('base64');

  return res.status(200).json({
    token,
    role: 'admin',
    portfolios: [],
    email,
  });
}
