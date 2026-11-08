const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Route pour générer le Pair Code
app.post("/api/pair-code", async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Numéro de téléphone requis." });
    }

    // Nettoyage strict du numéro (chiffres uniquement)
    phone = phone.replace(/[^0-9]/g, "");
    console.log(`\n[Pairing] Initialisation pour le numéro : ${phone}`);

    const tempSessionId = `session_${phone}_${Date.now()}`;
    const tempDir = path.join(__dirname, "temp", tempSessionId);

    let isCodeSent = false;

    async function initSocket() {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
            },
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on("creds.update", saveCreds);

        // Demande du code à 8 chiffres auprès des serveurs WhatsApp
        if (!sock.authState.creds.registered && !isCodeSent) {
            await delay(2500);
            try {
                const code = await sock.requestPairingCode(phone);
                console.log(`[Pairing] Code généré avec succès : ${code}`);
                isCodeSent = true;
                res.json({ success: true, code: code });
            } catch (err) {
                console.error("[Pairing] Échec de la demande de code :", err.message);
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Impossible d'obtenir le code. Vérifiez l'indicatif de votre numéro." });
                }
            }
        }

        // Surveillance de l'état de la connexion
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (connection === "close") {
                // Reconnexion automatique lors de la négociation (Code 515 / restartRequired)
                if (statusCode === DisconnectReason.restartRequired || statusCode === 515 || statusCode !== DisconnectReason.loggedOut) {
                    console.log("[Pairing] Reconnexion technique nécessaire pour valider la clé...");
                    initSocket();
                } else {
                    console.log("[Pairing] Liaison abandonnée ou échouée.");
                    if (fs.existsSync(tempDir)) {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                }
            } else if (connection === "open") {
                console.log("✅ [Pairing] Connexion établie ! Génération du SESSION_ID...");

                await delay(3000);

                const credsPath = path.join(tempDir, "creds.json");
                if (fs.existsSync(credsPath)) {
                    const credsData = fs.readFileSync(credsPath, "utf-8");
                    const sessionId = "Kyrox~" + Buffer.from(credsData).toString("base64");
                    const userJid = `${phone}@s.whatsapp.net`;

                    // Envoi de la clé par message privé sur WhatsApp
                    await sock.sendMessage(userJid, {
                        text: `╔═══════════════════════╗\n` +
                              `║   *KYROX-MD SESSION ID*    \n` +
                              `╚═══════════════════════╝\n\n` +
                              `Votre bot est prêt ! Voici votre identifiant de session :\n\n` +
                              `\`\`\`${sessionId}\`\`\`\n\n` +
                              `⚠️ *Attention :* Conservez cette clé précieusement et ne la partagez jamais.`
                    });

                    console.log("📩 [Pairing] SESSION_ID envoyé sur WhatsApp avec succès !");

                    await delay(3000);

                    // ✅ CORRECTION CRITIQUE : Fermeture propre SANS révocation de l'appareil
                    sock.end(undefined);

                    // Nettoyage du dossier temporaire
                    if (fs.existsSync(tempDir)) {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                    console.log("[Pairing] Session terminée et dossier temporaire nettoyé.");
                }
            }
        });
    }

    try {
        await initSocket();
    } catch (e) {
        console.error("[Pairing] Erreur inattendue :", e);
        if (!res.headersSent) {
            res.status(500).json({ error: "Erreur interne du serveur." });
        }
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Serveur Kyrox-Session prêt sur le port ${PORT}`);
});
