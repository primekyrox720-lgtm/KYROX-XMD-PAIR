const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Endpoint pour demander le Pair Code
app.post("/api/pair-code", async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Veuillez fournir un numéro de téléphone." });
    }

    // Nettoyage du numéro (supprime +, espaces, tirets)
    phone = phone.replace(/[^0-9]/g, "");

    const tempSessionId = `session_${phone}_${Date.now()}`;
    const tempDir = path.join(__dirname, "temp", tempSessionId);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        sock.ev.on("creds.update", saveCreds);

        // Si le client n'est pas encore enregistré, on demande le code
        if (!sock.authState.creds.registered) {
            await delay(1500); // Petit délai indispensable pour Baileys
            const code = await sock.requestPairingCode(phone);
            res.json({ success: true, code: code });
        }

        // Écoute de la connexion
        sock.ev.on("connection.update", async (update) => {
            const { connection } = update;

            if (connection === "open") {
                await delay(3000);

                // Lire les identifiants enregistrés
                const credsPath = path.join(tempDir, "creds.json");
                if (fs.existsSync(credsPath)) {
                    const credsData = fs.readFileSync(credsPath, "utf-8");
                    // Encoder en base64 pour avoir un SESSION_ID compact
                    const sessionId = "Kyrox~" + Buffer.from(credsData).toString("base64");

                    const userJid = `${phone}@s.whatsapp.net`;

                    // Envoi du SESSION_ID sur le WhatsApp de l'utilisateur
                    await sock.sendMessage(userJid, {
                        text: `╔═══════════════════════╗\n` +
                              `║   *KYROX-MD SESSION ID*    \n` +
                              `╚═══════════════════════╝\n\n` +
                              `Voici votre identifiant de session :\n\n` +
                              `\`\`\`${sessionId}\`\`\`\n\n` +
                              `⚠️ *ATTENTION :* Ne partagez ce code avec personne ! Il donne l'accès à votre WhatsApp.`
                    });

                    await delay(2000);
                    // Déconnexion et suppression du dossier temporaire
                    await sock.logout();
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            }
        });

    } catch (error) {
        console.error("Erreur pairing:", error);
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        res.status(500).json({ error: "Échec de génération du code. Vérifiez le numéro." });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur Kyrox-Session démarré sur http://localhost:${PORT}`);
});
