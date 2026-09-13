# CRM Agrotienda Bioplanta

Contexto para cualquier sesion de Claude que trabaje en este repositorio. El contexto completo y detallado (historial de fases, decisiones, diseno) vive en el Project de claude.ai "CRM AGROTIENDA BIIOPLANTA" -- este archivo es un resumen operativo para no tener que releer todo eso antes de tocar codigo.

## Que es esto
Sitio interno + publico para Agrotienda Bioplanta (dos sedes: Chigorodo y Belen de Bajira). Unifica mostrador, administrativo, gerencia, proveedores y listado de precios publicos. Usuario principal: Carlos Burgos (Coordinador Comercial, Super Admin), no tecnico -- todo el flujo esta pensado para que el no dependa de git/terminal directamente.

## Arquitectura
- Frontend: HTML/CSS/JS estatico, un archivo por pantalla, sin build ni framework ni dependencias de npm (salvo las funciones serverless). Paleta de marca en variables CSS: verde #4F7C5A (primario), vino #984745 (secundario/alerta), beige #E6CEAB (terciario/neutro).
- Backend/datos: Supabase (Postgres + Auth + Storage), con RLS en casi todas las tablas. Funciones auxiliares clave: es_super_admin(), mi_sede(), tiene_permiso(modulo::smallint, nivel), tiene_submodulo(modulo::smallint, sub), sede_visible().
- Funciones serverless (carpeta api/): usan la service_role key de Supabase (nunca en el codigo, solo como env var en Vercel) para operaciones que el navegador no puede hacer (gestion de usuarios, cargas masivas de inventario/ventas/cartera).
- Despliegue: GitHub -> Vercel, deploy automatico al hacer push a main. Repo: github.com/carlosgalvanpruebas-boop/crm-bioplanta (publico). Sitio: crm-bioplanta.vercel.app.
- Fuente de verdad comercial: SAP Business One. La sincronizacion automatica con SAP no existe todavia -- todo se carga manualmente subiendo Excels exportados de SAP desde pantallas propias del CRM (cargar-informacion.html y afines).

## Convenciones importantes (aprendidas a las malas -- no repetir estos bugs)
- tiene_permiso(...)/tiene_submodulo(...) en cualquier policy de RLS: el numero de modulo SIEMPRE con ::smallint, si no Postgres no encuentra la funcion.
- inventario tiene una fila por (codigo_sap, sede), no una por producto. Cualquier vista, calculo o escritura pensada "por producto" debe agrupar/actualizar por codigo_sap, nunca por id de fila -- si no, el cambio queda aplicado solo a una sede. Ya paso con precios.html y con el ajuste manual de minimo/maximo en analisis-inventario.html.
- Clasificacion de que articulos son de la agrotienda (vs. otras lineas de negocio que comparten el mismo SAP): por articulo, no por grupo -- un articulo es de agrotienda si tiene stock > 0 en el almacen "AGROTIENDA CHIGORODO" o "AGROTIENDA BAJIRA". El nombre del grupo SAP no es un filtro limpio por si solo.
- CREATE OR REPLACE VIEW en Postgres solo permite agregar columnas al final de la lista, nunca insertarlas en medio ni reordenarlas (error 42P16).
- Antes de escribir RLS o insertar en una tabla real ya existente (heredada de un desarrollo anterior en Firebase/Netlify), revisar information_schema.columns y tambien los CHECK constraints con pg_get_constraintdef -- varias tablas reales (tareas, por ejemplo) tienen reglas mas estrictas de lo asumido.
- El repo es publico: se puede leer cualquier archivo actual con curl https://raw.githubusercontent.com/carlosgalvanpruebas-boop/crm-bioplanta/<rama-o-commit>/<archivo> sin credenciales.
- "CAREPA" como centro de costo (OcrCode) en ventas es el nombre antiguo de la sede de Chigorodo antes de un traslado (confirmado por Carlos, sep-2026) -- se mapea a 'Chigorodo', no es una tercera sede ni hay que excluirlo.
- Los scripts SQL que Carlos debe correr manualmente en el SQL Editor de Supabase (no hay ejecucion directa de SQL disponible desde aqui) viven en sql/, uno por fase (ver esquema-supabase.md en el Project de claude.ai para el historial completo de fases anteriores, que no se guardaron como archivos).

## Estado (ver esquema-supabase.md y vision-general-proyecto.md en el Project de claude.ai para el detalle completo)
- Modulo 1 (Mostrador) y 2 (Administrativo): funcionales en produccion, salvo 1.3 y 2.3 (backend listo, falta pantalla).
- Modulo 3 (Gerencia): solo wireframe, bloqueado en parte por datos que debe entregar contabilidad (PyG, umbrales de riesgo).
- Modulo 4 (Proveedor) y 5 (Precios): publicos, funcionales.
- Modulo 6 (Portal de pedidos de clientes): pausado a peticion de Carlos.
- Bug conocido de mayor prioridad (ver revision-diseno-crm.md): precios.html/listado_precios_publico puede mostrar productos duplicados con precios distintos cuando no se agrupa por codigo_sap -- revisar si sigue vigente antes de tocar ese modulo.
- Sincronizacion automatica con SAP: pendiente de construir (Service Layer / DI API / exportacion programada) -- es el mayor bloqueo tecnico del proyecto.

## Flujo de trabajo
Antes de este archivo, el flujo era: Claude entrega el HTML completo -> Carlos lo pega a mano en GitHub (arrastrar y soltar) -> Vercel despliega. Eso causo incidentes (archivos pegados con contenido equivocado, archivos duplicados). Ahora el repo esta clonado localmente en el computador de Carlos y Claude puede editar archivos y hacer git commit/git push directamente -- evitar volver al flujo de copiar/pegar salvo que Carlos lo pida explicitamente.
