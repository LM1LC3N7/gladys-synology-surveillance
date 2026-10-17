// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }.
// -----------------------------------------------------------------------------

import { AUTH_FINAL, CODES } from './synology/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** Why the NAS failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.IMAGE_TOO_LARGE:
      return { en: 'image too large for Gladys', fr: 'image trop lourde pour Gladys' };
    case CODES.NO_API:
      return { en: 'API missing', fr: 'API absente' };
    case CODES.API:
      return { en: `DSM error ${err.apiCode}`, fr: `erreur DSM ${err.apiCode}` };
    case CODES.NOT_LOGGED_IN:
      return {
        en: 'not logged in to the NAS yet (session lost, next login in a few seconds)',
        fr: 'pas encore connecté au NAS (session perdue, nouvelle connexion dans quelques secondes)',
      };
    default:
      return { en: err?.code ?? 'error', fr: err?.code ?? 'erreur' };
  }
}

const UNREACHABLE_TAIL = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ count, homeMode }) =>
      join(
        {
          en: `Surveillance Station answers: ${count} ${plural(count, 'camera', 'cameras')}.`,
          fr: `Surveillance Station répond : ${count} ${plural(count, 'caméra', 'caméras')}.`,
        },
        homeMode === null
          ? { en: '', fr: '' }
          : homeMode
            ? { en: 'Home Mode on.', fr: 'Mode Maison activé.' }
            : { en: 'Home Mode off.', fr: 'Mode Maison désactivé.' },
      ),
    urlEmpty: {
      en: 'Type the address of your NAS (e.g. https://192.168.1.10:5001).',
      fr: 'Saisissez l’adresse de votre NAS (ex. https://192.168.1.10:5001).',
    },
    urlInvalid: {
      en: 'The NAS address is not valid: type https://host:port (e.g. https://192.168.1.10:5001), without a path.',
      fr: 'L’adresse du NAS n’est pas valide : saisissez https://hôte:port (ex. https://192.168.1.10:5001), sans chemin.',
    },
    urlCredentials: {
      en: 'Remove the user name and password from the NAS address: they have their own fields.',
      fr: 'Retirez l’identifiant et le mot de passe de l’adresse du NAS : ils ont leurs propres champs.',
    },
    missingCredentials: {
      en: 'Type the user name and password of the DSM account dedicated to Gladys.',
      fr: 'Saisissez l’identifiant et le mot de passe du compte DSM dédié à Gladys.',
    },
    otpInvalid: {
      en: 'The 2-step verification code must be 6 digits.',
      fr: 'Le code de validation en deux étapes doit faire 6 chiffres.',
    },
    credentials: {
      en: 'DSM refused the user name or password (or the account is disabled, locked or its password expired). Gladys does not try again by itself (DSM blocks an address after a few failed logins): fix the configuration and save it, or press "Test the connection".',
      fr: 'DSM a refusé l’identifiant ou le mot de passe (ou le compte est désactivé, verrouillé ou son mot de passe a expiré). Gladys ne réessaie pas seul (DSM bloque une adresse après quelques échecs) : corrigez la configuration et enregistrez-la, ou appuyez sur « Tester la connexion ».',
    },
    otpRequired: {
      en: 'This account uses 2-step verification: type a fresh code of your authenticator app in "2-step verification code" and save at once (the code lasts 30 s). Gladys then keeps a device token and never asks again. Simpler: a dedicated account without 2-step verification.',
      fr: 'Ce compte utilise la validation en deux étapes : saisissez un code tout frais de votre application d’authentification dans « Code de validation en deux étapes » et enregistrez aussitôt (le code dure 30 s). Gladys garde ensuite un jeton d’appareil et ne le redemande plus. Plus simple : un compte dédié sans validation en deux étapes.',
    },
    otpFailed: {
      en: 'DSM refused the 2-step verification code: type a fresh one and save at once.',
      fr: 'DSM a refusé le code de validation en deux étapes : saisissez-en un nouveau et enregistrez aussitôt.',
    },
    otpEnforced: {
      en: 'DSM requires 2-step verification for this account, but it is not set up yet: set it up in DSM, or use a dedicated account that is exempt.',
      fr: 'DSM exige la validation en deux étapes pour ce compte, mais elle n’est pas encore configurée : configurez-la dans DSM, ou utilisez un compte dédié qui en est dispensé.',
    },
    privilege: {
      en: 'The account has no access to Surveillance Station: give it a Surveillance Station privilege profile (in Surveillance Station, Privilege settings).',
      fr: 'Le compte n’a pas accès à Surveillance Station : donnez-lui un profil de privilèges Surveillance Station (dans Surveillance Station, Paramètres de privilèges).',
    },
    noSurveillance: (delay) =>
      join(
        {
          en: 'Surveillance Station does not answer on this NAS: is the package installed and running?',
          fr: 'Surveillance Station ne répond pas sur ce NAS : le paquet est-il installé et lancé ?',
        },
        UNREACHABLE_TAIL(delay),
      ),
    tlsUntrusted: (delay) =>
      join(
        {
          en: 'The certificate of the NAS is not trusted (DSM’s own self-signed certificate?): tick "Accept the self-signed certificate of the NAS", or install a certificate from a known authority.',
          fr: 'Le certificat du NAS n’est pas reconnu (le certificat auto-signé de DSM ?) : cochez « Accepter le certificat auto-signé du NAS », ou installez un certificat d’une autorité reconnue.',
        },
        UNREACHABLE_TAIL(delay),
      ),
    tlsChanged: (delay) =>
      join(
        {
          en: 'The certificate of the NAS changed since Gladys trusted it. If you renewed it, press "Trust the new certificate"; otherwise another machine may be impersonating your NAS.',
          fr: 'Le certificat du NAS a changé depuis que Gladys lui fait confiance. Si vous l’avez renouvelé, appuyez sur « Faire confiance au nouveau certificat » ; sinon une autre machine se fait peut-être passer pour votre NAS.',
        },
        UNREACHABLE_TAIL(delay),
      ),
    notSynology: (delay) =>
      join(
        {
          en: 'This address does not answer like Synology DSM: check the scheme and the port (5001 for https, 5000 for http).',
          fr: 'Cette adresse ne répond pas comme Synology DSM : vérifiez le protocole et le port (5001 en https, 5000 en http).',
        },
        UNREACHABLE_TAIL(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'The NAS asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Le NAS demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        UNREACHABLE_TAIL(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `DSM answers with a server error (HTTP ${status}): it may be restarting or updating.`,
          fr: `DSM répond par une erreur serveur (HTTP ${status}) : il redémarre ou se met peut-être à jour.`,
        },
        UNREACHABLE_TAIL(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'The NAS does not answer:', fr: 'Le NAS ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        UNREACHABLE_TAIL(delay),
      ),
  },
  /** The message of a final login refusal. */
  refusal(err) {
    if (err.apiCode === AUTH_FINAL.OTP_REQUIRED) return T.status.otpRequired;
    if (err.apiCode === AUTH_FINAL.OTP_FAILED) return T.status.otpFailed;
    if (err.apiCode === AUTH_FINAL.OTP_ENFORCED) return T.status.otpEnforced;
    return T.status.credentials;
  },
  test: {
    ok: ({ count, names }) => ({
      en: `Connected: ${count} ${plural(count, 'camera', 'cameras')}${count ? ` (${names})` : ''}.`,
      fr: `Connecté : ${count} ${plural(count, 'caméra', 'caméras')}${count ? ` (${names})` : ''}.`,
    }),
    trusted: {
      en: 'The new certificate is trusted: see the connection status above.',
      fr: 'Le nouveau certificat est accepté : voyez l’état de la connexion ci-dessus.',
    },
  },
  errors: {
    unknownDevice: 'Unknown device or feature: pick one of this integration',
    notConnected: 'The NAS is not connected: see the configuration of the integration',
    invalidValue: 'Invalid value: 0 or 1 expected',
    controlDisabled:
      'Disabling a camera or turning Home Mode on reduces the surveillance: allow it first in the configuration of the integration ("Allow reducing the surveillance")',
    tooSlow: 'The NAS answered too slowly: nothing was sent, try again',
    unknownState: (err) =>
      `The current state could not be read (${reasonOf(err).en}): nothing was sent`,
    unknownCamera: 'This camera is no longer in Surveillance Station: nothing was sent',
    noConfirmation: (err) =>
      `No confirmation from the NAS (${reasonOf(err).en}): the state is read again`,
    notSent: (err) => `The command could not reach the NAS (${reasonOf(err).en}): nothing was sent`,
    refused: (err) => `The NAS refused the command (${reasonOf(err).en})`,
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    busy: 'The NAS asked Gladys to slow down: nothing was sent, try again later',
    busyRefused:
      'The NAS refused the request (HTTP 429, too many requests): nothing was done, Gladys pauses its requests',
    testTooLong:
      'The NAS has not answered yet: see the connection status in a moment (nothing else to do)',
    cameraDisabled: 'The camera is disabled in Surveillance Station: no image',
    image: (name, err) => `No image of "${name}": ${reasonOf(err).en}`,
    selfSignedOff:
      'The self-signed certificate is not accepted: tick "Accept the self-signed certificate of the NAS" first',
  },
};
