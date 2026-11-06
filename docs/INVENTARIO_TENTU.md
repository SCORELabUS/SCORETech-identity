# Inventario de reutilización de Tentu

Inspección: 5 de noviembre de 2026. Rutas relativas al directorio local
`/Users/alejandro/Desktop/Proyectos/TenTuPlaza`.

Este inventario acompaña al [plan](PLAN_IMPLEMENTACION.md). Describe el código
observado y las piezas candidatas a extracción; no es una relación de versiones
publicadas ni una certificación de todos sus flujos.

## 1. Procedencia observada

| Repositorio | HEAD local | Rama | Cambios locales totales al inspeccionar |
| --- | --- | --- | --- |
| `tentu-platform` | `cb5acccf6ddd3900e26a6fdab0e744860d04d340` | develop | 18 entradas |
| `tentu-applications` | `fb4ba3b5606d40ee4c6b8bcc2cf5fe169fda4f87` | develop | 87 entradas |
| `tentu-sdks` | `16f652464c08fda19e45bf2a362eb47530ef30b0` | develop | 0 |
| `tentu-gitops` | `78c56299154e83e629106253e4ed7c9d66034943` | develop | 0 |
| `tentu-docs` | `3a17cdec5df44ddbb72676a36b0358b1581d2a53` | develop | 0 |

Dentro de los ámbitos candidatos había 18 entradas modificadas/no seguidas en
platform y 25 en applications. Incluyen ficheros sin seguimiento, por lo que un
commit por sí solo no reproduce todo lo inspeccionado. Antes de extraer, elaborar
la lista exacta y una copia/patch revisada de los cambios necesarios. No alterar
ni descartar el trabajo local de Tentu.

`tentu-platform` y `tentu-applications` declaran MIT, copyright TenTuPlaza; conservar
esos avisos en el código reutilizado. No se encontró un LICENSE raíz en
`tentu-sdks` ni en `tentu-docs`: no asumir que el SDK se puede redistribuir bajo
otra licencia sin aclararlo. SCORETech-identity ya contiene su licencia MIT.

## 2. Matriz de componentes

| Origen | Evidencia observada | Tratamiento propuesto |
| --- | --- | --- |
| `tentu-platform/identity-provider` | Dockerfile Keycloak 26.7.1; SPI Maven Java 21; tema FreeMarker; tests; chart y laboratorio | Base principal del provider SCORE |
| `tentu-platform/identity-config-sync` | Chart/job de keycloak-config-cli + registro transaccional; sin runtime propio de aplicación | Extraer plantillas/configuración y aplicador para Compose; Helm queda como referencia |
| `tentu-applications/identity/account-web` | React 19/Vite/Tailwind 4, oidc-client-ts; paquete 0.11.6 | Conservar configuración personal/seguridad/sesiones; recortar negocio y rebrand |
| `tentu-applications/identity/account-api` | Express 5/TypeScript/Node 22; paquete 0.4.4; sin BD propia | Autoservicio con sujeto verificado y credencial propia |
| `tentu-applications/identity/admin-web` | React 19/Vite/Tailwind 4; paquete 0.21.3; SDK y UI compartida | Gestión de personas/identidad y recorte de módulos ajenos |
| `tentu-applications/identity/admin-api` | Express 5/TypeScript; paquete 0.16.5; catálogo/GitHub y varios gateways | Conservar identidad y editor GitHub; retirar negocio y adaptar publicación a Compose sin Argo |
| `tentu-applications/identity/shared` | Paquete interno 0.3.1, autenticador jose, clientes Keycloak y fachada Account | Extraer a paquete workspace de servidor, manteniendo separación de autoridad |
| `tentu-applications/shared/ui` | Paquete 0.15.4; controles, tokens y plugin Tailwind/Vite | Copiar solo componentes requeridos; adaptar tokens y exports a SCORE |
| `tentu-applications/scripts` | Compilador Ruby, agregador/contrato, promoción y pruebas | Reutilizar núcleo declarativo y adaptar wrappers a un repositorio |
| `tentu-sdks/typescript/React/tentu-identity` | UI de sesión y permisos; consumidor en Admin | Evitar dependencia del registry Tentu; revisar licencia antes de extracción |
| `tentu-sdks/typescript/Express/tentu-identity` | SDK de verificación para integraciones | Referencia futura; las APIs actuales ya usan identity/shared |
| `tentu-gitops/environments/identity` | Catálogo, contratos seleccionados y revisiones por entorno | Referencia estructural; no copiar usuarios/roles de negocio/snapshots operativos |
| `tentu-applications/identity/database` y plataforma PostgreSQL | Despliegue de persistencia | Reutilizar criterios operativos; instancia/base separada para SCORE |
| `identity/oppositions-api`, `legal-api`, `legal-database`, `docs-api` | Dominios/API ajenos al alcance acordado | Excluir del stack inicial |

Las versiones se leen de los manifiestos locales; no son una combinación
necesariamente publicada ni validada de forma conjunta.

## 3. Ficheros y puntos de cambio

### Provider y sincronización

- `tentu-platform/identity-provider/Dockerfile`: build Maven y provider antes de
  `kc.sh build`; actualmente no configura el prefijo HTTP de SCORE.
- `providers/email-otp/pom.xml`: dependencia del SPI ligada a Keycloak 26.7.1.
- `providers/email-otp/src/main/java/es/tentuplaza/identity/emailotp/`: autenticación,
  acciones de passkey, tickets de step-up, mutación transaccional de usuarios,
  autorización, invitaciones, recuperación y entidades JPA.
- `AuthenticationPolicy.java` y `AuthenticationPolicyMapper.java`: clasificación
  administrativa basada en `administrador`, pruebas de sesión y claims `tentu_*`.
  Adaptar política para operadores delegados si toda administración exige passkey.
- `RegistrationPolicy.java`: atributo `tentu.registration.default-role`. SCORE
  requiere registro sin acceso automático a servicios.
- `StepUpResourceFactory.java`: audiencia/cliente, origen, sesión, expiración y
  tickets de un solo uso; conservar invariantes al adaptar callbacks/prefijo.
- `UserMutationResourceFactory.java`: parches bajo bloqueo/transacción. No
  sustituirlos por GET+PUT que pueda sobrescribir actualizaciones concurrentes.
- `LegalGate.java`, acciones/mappers/directorio legales y registros `META-INF`:
  retirar acoplamiento a Legal API y su activación coherentemente.
- `themes/tentuplaza/login` y `themes/tentuplaza/email`: tema nuevo `score`, textos,
  assets, URLs, referencias editoriales y traducciones. Hay footer de academia.
- `charts/identity-provider/values.yaml`: hostname, SMTP, recursos y features.
  La configuración actual requiere credenciales/servicios de infraestructura Tentu.
- `identity-config-sync/charts/identity-config-sync`: configuración de realm,
  perfiles, acciones, clientes, scopes, secretos y sincronización del registro.

### Account

- `account-web/src/App.tsx`: secciones profile/oppositions/preferences/security/
  payments/sessions/legal. Conservar perfil, preferencias, seguridad y sesiones;
  retirar paneles de dominio y simplificar perfil.
- `account-web/src/auth.ts`: callback raíz `/auth/callback`, invitación `/invite`,
  acciones con IDs `tentu-*`, almacenamiento en sessionStorage.
- `account-web/src/config.ts`: fallback a ranking y APIs de oposiciones; quitar
  esas dependencias y configurar explícitamente base paths.
- `account-web/src/application-return.ts`: reaprovechar allowlist de retorno,
  eliminando destinos Tentu. No aceptar una URL arbitraria del usuario.
- `account-api/src/main/app.ts`: retirar gateway legal y `/internal/calls-avatar`.
- `account-api/src/main/modules/account/`: mantener rutas propias y quitar pagos,
  comprobación de correo comercial y campos fiscales.
- `identity/shared/src/keycloak-client.ts`: Account usa fachada restringida;
  transporte interno distinto del issuer canónico cuando se configura.
- La subida de avatar usa S3 privado y URL firmada. No es una función puramente
  estática; el plan la condiciona a almacenamiento privado configurado.

### Admin

- `admin-web/src/AdminNavigation.tsx`: personas, oposiciones, comunicaciones,
  llamadas, legal y seguridad; recortar a personas/identidad.
- `admin-web/src/App.tsx`, `api.ts` y pantallas `User*`: revisar ficha completa,
  evitando conservar consultas a matrículas, comercio o dominio eliminado.
- `admin-web/src/auth.ts`: callbacks raíz y logout por origin; localStorage para
  tokens. Adaptar prefijo y política de almacenamiento.
- `admin-web/src/config.ts`: hosts fijos Tentu e inferencias de staging; runtime
  config SCORE explícita, con accountUrl/accountApiUrl propias.
- `CataloguePanel.tsx`, `CataloguePromotion.tsx`, `CatalogueCompare.tsx`: base del
  editor de roles confirmado. Conservar edición, diferencias, historial y
  restauración; retirar selectores de promoción entre entornos y dependencia Argo.
- `admin-api/src/main/app.ts`: eliminar montaje de WooCommerce, domain-gateway,
  calls-gateway, directorio de llamadas y legal-gateway. Conservar autenticador,
  identidad, invitaciones y step-up.
- `admin-api/src/main/modules/catalogue`: conservar `github.ts`, modelo, validación,
  concurrencia y auditoría para editar roles. Adaptar rama/rutas a SCORE y aplicar
  por job Compose. Distinguir catálogo deseado del realmente aplicado; las
  asignaciones se resuelven contra el segundo. Retirar consultas Argo CD.
- `admin-api/src/main/modules/identity/identity.routes.ts`: operaciones atómicas,
  gestión de usuarios, sesiones, credenciales y recuperación; rutas legacy de
  contraseña ya devuelven 410.
- `admin-api/identity/permissions.yaml`, `policies.yaml` y manifiestos de webs:
  reducir catálogo y audiencias; preservar permisos por operación y entrada.
- `shared/src/oidc-authenticator.ts`: JWT/JWKS, issuer/audiencia/azp y factor
  administrativo. Evitar exigir rol genérico para entrar o saltar la política
  de passkey por un rol delegado.

### Compilación del contrato

- `scripts/compile-tentuid.rb`: valida clientes, scopes, permisos/audiencias y
  restricciones de token. Hoy admite staging/production y añade URLs locales al
  perfil staging; adaptar explícitamente entornos SCORE y pruebas.
- `scripts/tenuid-contract.rb`: agregación, ownership, snapshots/digests y
  contratos ligados a artefactos; candidato a conservar como núcleo.
- `scripts/update-tentuid.rb`, `promote-tentuid.rb`, `bootstrap-tentuid.rb`:
  wrappers ligados a repositorios y layouts de GitOps; no trasladarlos tal cual.
- `scripts/test-compile-tentuid.rb`: pruebas del compilador a adaptar.

## 4. Acoplamientos que no cubre cambiar el realm

| Acoplamiento | Riesgo de una copia literal | Trabajo necesario |
| --- | --- | --- |
| Callback/logout en raíz | Redirecciones fuera de `/identity` | Base de cada web y callbacks exactos |
| Rutas de navegación y assets | 404 o HTML de SPHERE en callbacks/recursos | Vite, servidor estático y navegación con prefijo |
| Hostname decide entorno | Cambiar dominio puede cambiar permisos o destinos | Entorno y URLs explícitos |
| Dominio público e interno | Validación de issuer rota o llamadas internas inaccesibles | Conservar issuer público; configurar transporte privado |
| Paquetes `@tentuplaza/*` | Registry privado/clones hermanos necesarios | Workspace local y revisión de licencias |
| Catálogo y GitHub App | Admin depende de GitOps Tentu | Editor confirmado: App de SCORE, revisiones y aplicador Compose con estado verificado |
| Audiencias de negocio | Tokens con accesos ajenos | Contratos reducidos por cliente y políticas |
| SPI/claims/acciones/atributos | Fallos silenciosos si se renombra un solo consumidor | Mapa de productor-consumidores y pruebas conjuntas |
| WebAuthn | Dominios nuevos no heredan passkeys | RP ID/orígenes y recuperación planificados |
| Legal gate | Login puede depender de Legal API | Retirar hooks/clientes/gate coherentemente |
| Campos y comunicaciones comerciales | Perfil/registro inadecuados para SCORE | Reducir atributos, formulario y plantillas |
| JPA/changelogs propios | Pérdida o falta de entidades de invitación/recuperación | Conservar migraciones funcionales |
| Privilegio administrativo delegado | Passkey podría depender del rol compuesto | Clasificación por acceso administrativo sin cambiar autorización |

## 5. Pruebas y documentación aprovechables

En `identity-provider/tests/` hay checks de distribución/imagen y un laboratorio
de navegador con passwordless, passkeys, TOTP, OTP, recuperación y hardening.
`dev/compose.yaml` levanta PostgreSQL, Mailpit, Keycloak y almacenamiento de prueba;
los Make targets pueden arrancar las dos APIs/webs desde repos hermanos. Adaptar
el laboratorio a un solo repositorio y al prefijo real es una prioridad.

Las cuatro aplicaciones y `identity/shared` contienen pruebas de contratos,
autenticación, perfil, métodos, sesiones, invitaciones, permisos y catálogos.
Reutilizar las que correspondan a módulos retenidos y añadir las de SCORE descritas
en el plan. Los tests de comercio/negocio descartado no pertenecen al nuevo stack.

Documentación útil inspeccionada:

- `identity-provider/README.md`, `dev/README.md`, `docs/API.md` y OpenAPI del SPI.
- `identity-config-sync/README.md`.
- `tentu-applications/identity/docs/PERMISSIONS_AND_IDENTITY.md`.
- `tentu-applications/identity/docs/ACCOUNT_PREFERENCES.md`.
- README y OpenAPI de Account API/Admin API, y README de ambas webs.
- `tentu-gitops/.github/workflows/promote-artifacts.yaml`: revela que el compilador
  usado por promoción procede de `tentu-applications/scripts`.

No se ejecutaron suites, contenedores ni llamadas administrativas durante esta
planificación. No se modificaron los repositorios de Tentu, SPHERE o SPACE.

## 6. Evidencia adicional del destino

`SCORETech-identity` partía de README, `.gitignore` y licencia, sin código ni
arquitectura previa. No hay un servicio implementado que debamos preservar.

`SPHERE/nginx/production/nginx.conf` declara `sphere.score.us.es`, TLS, rutas API,
discovery OAuth/OIDC y fallback de su frontend. `SPHERE/docker/production/` contiene
Compose. Esto respalda la propuesta de integración de proxy, pero no confirma el
estado de la máquina desplegada. El nuevo discovery debe quedar en el realm
bajo `/identity/auth`, conservando los contratos raíz existentes de SPHERE.

La web pública de SCORE se inspeccionó mediante navegador y estilos calculados:
rojo `#BE1D37`, texto `#212529`, Source Sans Pro para texto y Bunken Tech Sans Pro
en títulos. El plan recoge una adaptación de esa marca, sin incorporar fuentes,
assets o dependencias de red a este repositorio durante la planificación.

## 7. Brevo de SPHERE y decisiones confirmadas

Se inspeccionaron además estos ficheros de SPHERE:

- `api/src/main/services/email/BrevoEmailService.ts`: SDK `@getbrevo/brevo`, clave
  `BREVO_API_KEY`, remitente `BREVO_SENDER_EMAIL` y nombre `BREVO_SENDER_NAME`.
  Usa la API transaccional para verificación, recuperación y notificaciones,
  con HTML/texto en inglés. No se leyó ningún valor de credencial.
- `api/src/main/config/container.ts`: registra `BrevoEmailService` como servicio
  de correo singleton.
- `api/src/test/unit-tests/brevo-email-service.test.ts`: sustituye el SDK y cubre
  envío transaccional y rechazo en producción sin clave. Estas pruebas no se
  ejecutaron como parte de la actualización documental.
- `api/package.json`: declara la dependencia `@getbrevo/brevo`.

SCORETech Identity usará el mismo proveedor por SMTP nativo de Keycloak, preservando
sus plantillas y flujos propios; la clave SMTP es distinta de la clave API que usa
SPHERE. La sección 6.6 del plan documenta transporte, remitente y configuración.
No se copia el servicio TypeScript a Java ni se añade un intermediario de correo.

El usuario confirmó conservar OTP por correo/passkeys/TOTP con passkey obligatoria
para administrar, incluir el editor de roles y mantener siempre inglés. Extraer
mensajes y UI de Tentu exige retirar traducciones y textos visibles españoles;
el cambio de idioma abarca también errores del SPI y correos, no solo los menús.
