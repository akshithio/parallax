function createDeliveryTracker() {
  const pending = new Map();

  return {
    remember(msgId, text, convId) {
      if (!msgId) return;
      pending.set(msgId, { text, convId });
    },

    acknowledge(msgId, acknowledgedConvId) {
      if (!msgId) return null;
      const delivery = pending.get(msgId);
      if (!delivery) return null;
      pending.delete(msgId);
      return {
        text: delivery.text,
        msgId,
        convId: acknowledgedConvId || delivery.convId || '',
      };
    },

    fail(msgId) {
      if (msgId) pending.delete(msgId);
    },

    has(msgId) {
      return pending.has(msgId);
    },
  };
}

module.exports = { createDeliveryTracker };
