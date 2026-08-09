function acceptsResponseSource(source) {
  return source === 'network' || source === 'page-recovery';
}

module.exports = { acceptsResponseSource };
