function getRegistrationData(session, alexa) {
  return (
    alexa?.cookieData
    || session?.cookieData
    || session?.formerRegistrationData
    || alexa?._options?.formerRegistrationData
    || null
  );
}

function getSessionMeta(config, session = null, alexa = null) {
  const reg = getRegistrationData(session, alexa);
  const now = Date.now();
  const savedAt = session?.savedAt ? Date.parse(session.savedAt) : null;
  const tokenDate = reg?.tokenDate ? Number(reg.tokenDate) : null;

  return {
    savedAt: session?.savedAt || null,
    sessionAgeHours: savedAt ? Math.round((now - savedAt) / 3600000) : null,
    tokenDate: tokenDate ? new Date(tokenDate).toISOString() : null,
    tokenAgeHours: tokenDate ? Math.round((now - tokenDate) / 3600000) : null,
    hasRefreshToken: Boolean(reg?.refreshToken),
    hasLocalCookie: Boolean(reg?.localCookie),
    hasMacDms: Boolean(reg?.macDms),
    dataVersion: reg?.dataVersion ?? null,
    amazonPage: session?.amazonPage || reg?.amazonPage || config?.amazonPage || null,
  };
}

module.exports = {
  getRegistrationData,
  getSessionMeta,
};
