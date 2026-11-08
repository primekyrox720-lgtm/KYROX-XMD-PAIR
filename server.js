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

app.post("/api/pair-code", async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: "Numéro de téléphone requis." });
    }

    // Nettoyage strict du numéro
    phone = phone.replace(/[^0-9]/g, "");
    console.log(`\n[Pairing] Début de la procédure pour : ${phone}`);

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
            // Empreinte reconnue officiellement par WhatsApp pour éviter les rejets
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on("creds.update", saveCreds);

        // Si le code n'a pas encore été envoyé au site web
        if (!sock.authState.creds.registered && !isCodeSent) {
            await delay(2500); // Délai nécessaire pour que le socket soit bien établi
            try {
                const code = await sock.requestPairingCode(phone);
                console.log(`[Pairing] Code généré avec succès : ${code}`);
                isCodeSent = true;
                res.json({ success: true, code: code });
            } catch (err) {
                console.error("[Pairing] Erreur génération code :", err.message);
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Erreur lors de la demande du code. Vérifiez le format du numéro." });
                }
            }
        }

        // Surveillance de la connexion (Gère la fameuse coupure 515)
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (connection === "close") {
                console.log(`[Pairing] Connexion interrompue (Code: ${statusCode}).`);

                // Si WhatsApp demande un redémarrage (Code 515) ou coupure temporaire, ON RECONNECTE IMMÉDIATEMENT
                if (statusCode === DisconnectReason.restartRequired || statusCode === 515 || statusCode !== DisconnectReason.loggedOut) {
                    console.log("[Pairing] Finalisation de la liaison... Reconnexion en cours.");
                    initSocket(); // Relance avec le même dossier temporaire pour finaliser la liaison
                } else {
                    console.log("[Pairing] Session annulée ou expirée.");
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            } else if (connection === "open") {
                console.log("✅ [Pairing] Liaison WhatsApp validée avec succès !");

                await delay(3000);

                const credsPath = path.join(tempDir, "creds.json");
                if (fs.existsSync(credsPath)) {
                    const credsData = fs.readFileSync(credsPath, "utf-8");
                    const sessionId = "Kyrox~" + Buffer.from(credsData).toString("base64");
                    const userJid = `${phone}@s.whatsapp.net`;

                    // Envoi du SESSION_ID sur WhatsApp
                    await sock.sendMessage(userJid, {
                        text: `╔═══════════════════════╗\n` +
                              `║   *KYROX-MD SESSION ID*    \n` +
                              `╚═══════════════════════╝\n\n` +
                              `Votre bot est prêt ! Voici votre identifiant de session :\n\n` +
                              `\`\`\`${sessionId}\`\`\`\n\n` +
                              `⚠️ *Attention :* Conservez cette clé précieusement et ne la partagez jamais.`
                    });

                    console.log("📩 [Pairing] Session envoyée sur le WhatsApp de l'utilisateur !");

                    await delay(3000);
                    await sock.logout();
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            }
        });
    }

    try {
        await initSocket();
    } catch (e) {
        console.error("[Pairing] Erreur critique :", e);
        if (!res.headersSent) {
            res.status(500).json({ error: "Erreur serveur interne." });
        }
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Serveur Kyrox-Session prêt sur le port ${PORT}`);
});
