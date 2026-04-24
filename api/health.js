export default async function handler(req, res) {
  const diag = {
    ok: true,
    node: process.version,
    envPresent: {
      NEON_DATABASE_URL: !!process.env.NEON_DATABASE_URL,
      ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_ACCOUNTS_HOST: !!process.env.ZOHO_ACCOUNTS_HOST,
      ZOHO_API_HOST: !!process.env.ZOHO_API_HOST,
    },
  };
  try {
    const mod = await import('@neondatabase/serverless');
    diag.neonDriverImported = typeof mod.neon === 'function';
  } catch (e) {
    diag.neonDriverImported = false;
    diag.neonImportError = String(e);
  }
  res.status(200).json(diag);
}
