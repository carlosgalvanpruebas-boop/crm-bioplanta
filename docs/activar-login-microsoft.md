# Cómo activar "Continuar con Microsoft" en el CRM

El botón y el código ya están listos en `login.html` (Fase 34). Para que
funcione de verdad faltan dos pasos que solo puede hacer alguien con acceso
administrativo a Microsoft 365 de Bioplanta (o quien administre esa cuenta) y
Carlos en el panel de Supabase. No requieren tocar código.

## 1. Registrar una app en Azure AD / Microsoft Entra ID

1. Entra a https://portal.azure.com con una cuenta administradora de Bioplanta.
2. Ve a **Microsoft Entra ID → Registros de aplicaciones → Nuevo registro**.
3. Nombre sugerido: `CRM Agrotienda Bioplanta`.
4. En "Tipos de cuenta admitidos" elige **"Cuentas solo en este directorio
   organizativo (Bioplanta Palmera S.A. — solo instancia única)"** — así solo
   el personal de Bioplanta puede entrar, nadie externo.
5. En "URI de redirección" elige tipo **Web** y pega:
   `https://fpqogvxssnoarzgxcitc.supabase.co/auth/v1/callback`
6. Crea el registro. Anota el **"Id. de aplicación (cliente)"** y el
   **"Id. de directorio (inquilino)"** que aparecen en la pantalla de resumen.
7. Ve a **Certificados y secretos → Nuevo secreto de cliente**, créalo (elige
   una expiración larga, ej. 24 meses) y copia el **valor** del secreto
   apenas se genera (no se vuelve a mostrar después).
8. Ve a **Permisos de API** y confirma que estén `email`, `openid`, `profile`
   (suelen venir por defecto) — si no, agrégalos y da "Conceder consentimiento
   de administrador".

## 2. Activar el proveedor en Supabase

1. Entra al panel de Supabase del proyecto → **Authentication → Providers**.
2. Busca **Azure** y actívalo.
3. Pega ahí el **Client ID**, el **Client Secret** y el **Tenant ID** (o el
   dominio del tenant) que anotaste arriba.
4. Guarda. Con eso el botón "Continuar con Microsoft" en `login.html` ya
   funcionará.

## Importante: solo funciona para quien ya tiene usuario en el CRM

Este botón es una segunda forma de entrar con la MISMA cuenta, no una forma
de crear cuentas nuevas automáticamente. Cada persona debe seguir teniendo su
perfil creado por Carlos en **Panel de Accesos** (con su correo de Bioplanta).
La primera vez que alguien entre con Microsoft, debe hacerlo con exactamente
el mismo correo con el que ya tiene su usuario y permisos en el CRM. Si al
entrar con Microsoft el sistema dice "Tu usuario no tiene un perfil
configurado todavía", avísame para revisar la vinculación de esa cuenta.
