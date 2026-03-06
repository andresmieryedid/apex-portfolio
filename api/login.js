export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};
  const validEmail = process.env.AUTH_EMAIL;
  const validPassword = process.env.AUTH_PASSWORD;

  if (!validEmail || !validPassword) {
    return res.status(500).json({ error: 'Auth not configured' });
  }

  if (email === validEmail && password === validPassword) {
    // Generate a simple session token
    const token = Buffer.from(`${email}:${Date.now()}:${process.env.AUTH_SECRET || 'vitru'}`).toString('base64');
    return res.status(200).json({ token });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
}
