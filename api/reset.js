import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = JSON.parse(Buffer.from(token, 'base64').toString());
    if (!user.email || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pfId = 'aggressive';
  await kv.del(`portfolio:${pfId}`);
  await kv.del(`init:prices:${pfId}`);
  await kv.del(`ytd:latest:${pfId}`);

  // Delete daily snapshots
  const keys = await kv.keys(`daily:${pfId}:*`);
  for (const key of keys) {
    await kv.del(key);
  }

  return res.status(200).json({ reset: true, deleted: keys.length + 3 });
}
