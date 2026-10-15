// Alternative public entry point; credentials and quota ledger remain in the bound Worker.
export default {
  fetch(request, env) {
    return env.PROXY.fetch(request);
  }
};
