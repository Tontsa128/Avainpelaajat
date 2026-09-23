export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "avainpelaajat",
    environment: "vercel",
    timestamp: new Date().toISOString()
  });
}
