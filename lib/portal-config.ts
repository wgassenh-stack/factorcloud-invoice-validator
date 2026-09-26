export const portalConfig = {
  clientName: process.env.NEXT_PUBLIC_PORTAL_CLIENT_NAME || "Will's Test Trucking LLC",
  clientShortName: process.env.NEXT_PUBLIC_PORTAL_CLIENT_SHORT_NAME || "Will's Test Trucking",
  environmentLabel: process.env.NEXT_PUBLIC_PORTAL_ENV_LABEL || 'Sandbox',
  features: {
    invoices: process.env.NEXT_PUBLIC_FEATURE_INVOICES !== 'false',
    submit: process.env.NEXT_PUBLIC_FEATURE_SUBMIT !== 'false',
    batch: process.env.NEXT_PUBLIC_FEATURE_BATCH !== 'false',
    alerts: process.env.NEXT_PUBLIC_FEATURE_ALERTS !== 'false',
    statements: process.env.NEXT_PUBLIC_FEATURE_STATEMENTS !== 'false',
  },
} as const;
