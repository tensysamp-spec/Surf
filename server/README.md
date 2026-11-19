# Your own AI server (free, on Oracle Cloud)

Runs an open model with [Ollama](https://ollama.com) on Oracle Cloud's Always Free ARM machine,
so the browser's AI features work without a Claude API key. The server is private: it only answers
requests that carry your access token, over HTTPS.

## 1. Make the free server (in your browser, ~10 minutes)

1. Sign up at <https://www.oracle.com/cloud/free/>. Oracle asks for a card to verify you; Always Free
   resources aren't charged. Pick a home region close to you — you can't change it later.
2. **Compute → Instances → Create instance**
   - **Image:** Canonical Ubuntu 24.04
   - **Shape:** Ampere → `VM.Standard.A1.Flex`, give it all the free OCPUs and memory your account
     shows (in 2026 that's about 2 OCPUs / 12 GB)
   - **SSH keys:** "Generate a key pair for me" and download the private key
   - If it says *Out of capacity*, try another availability domain or try again later.
3. **Open the web ports:** on the instance page click the subnet → its **Security List** →
   **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination port `80`. Add another for `443`.

## 2. Set it up (one command)

From your Mac, with the key you downloaded and the instance's public IP:

```sh
chmod 600 ~/Downloads/ssh-key-*.key
scp -i ~/Downloads/ssh-key-*.key ~/browser/server/setup.sh ubuntu@PUBLIC_IP:
ssh -i ~/Downloads/ssh-key-*.key ubuntu@PUBLIC_IP 'sudo bash setup.sh'
```

It installs Ollama and downloads `llama3.2:3b`. It also puts the server behind HTTPS at
`https://PUBLIC-IP.sslip.io`, with a free certificate, and prints an access token.

## 3. Connect the browser

**Settings (⌘,) → Your own AI server:** paste the address, model and token, click **Use server**,
then **Test**. **Use Claude** switches back.

## Good to know

- **Speed:** the free machine has no GPU. A 3B model writes a few words a second, which is fine
  for summaries and previews and slow for long chats.
- **Other models:** with 12 GB, `llama3.2:3b`, `gemma3:4b` and `qwen2.5:3b` run well, and 7–8B models
  run slowly. Run `sudo MODEL=gemma3:4b bash setup.sh` to switch, then change the model name in Settings.
- **What changes in the browser:** long pages are cut to about 40,000 characters. "Ask Claude (web
  search)" answers without searching.
- **Idle reclaim:** Oracle may reclaim Always Free machines that sit almost completely idle for a
  week. Regular use keeps it alive.
