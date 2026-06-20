const DEFAULT_DESTINATION = 'All devices';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseMessageDetails(record) {
  const rawMessage = normalizeText(record?.message);
  const sender = normalizeText(record?.device) || 'Unknown';
  let destination = DEFAULT_DESTINATION;
  let message = rawMessage;

  if (/^to\s+(all devices|everywhere)\b/i.test(rawMessage)) {
    destination = 'All devices';
    message = rawMessage.replace(/^to\s+(all devices|everywhere)\s*/i, '').trim() || rawMessage;
    return { sender, destination, message };
  }

  if (/^to\s+/i.test(rawMessage)) {
    const withoutTo = rawMessage.replace(/^to\s+/i, '');
    const words = withoutTo.split(/\s+/);

    if (words.length >= 4) {
      destination = words.slice(0, 2).join(' ');
      message = words.slice(2).join(' ');
    } else if (words.length === 3) {
      destination = words[0];
      message = words.slice(1).join(' ');
    } else if (words.length === 2) {
      destination = words[0];
      message = words[1];
    } else {
      destination = withoutTo;
      message = withoutTo;
    }
  }

  return {
    sender,
    destination: destination || DEFAULT_DESTINATION,
    message: message || rawMessage,
  };
}

function buildNetworkPayload(record, config) {
  const details = parseMessageDetails(record);
  const displaySeconds = Number(record?.displaySeconds)
    || Number(config.udpBroadcast?.defaultDisplaySeconds)
    || 30;

  return {
    version: 1,
    message: details.message,
    sender: details.sender,
    destination: details.destination,
    timestamp: new Date(record.timestamp || Date.now()).toISOString(),
    displaySeconds,
    trigger: record.trigger || 'unknown',
  };
}

module.exports = {
  parseMessageDetails,
  buildNetworkPayload,
  DEFAULT_DESTINATION,
};
