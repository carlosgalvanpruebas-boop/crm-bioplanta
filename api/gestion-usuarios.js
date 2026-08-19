// ============================================================
// FUNCIÓN SERVERLESS — Panel de Gestión de Accesos
// Esta función corre en el servidor de Vercel (nunca en el navegador
// del usuario), porque es la única que puede usar la "service_role key"
// de Supabase: la llave maestra que permite crear/eliminar usuarios de
// verdad y cambiarles la contraseña. Esa llave NUNCA debe estar en
// ningún archivo .html ni visible desde el navegador — por eso vive
// aquí, como variable de entorno (process.env.SUPABASE_SERVICE_ROLE_KEY)
// configurada directamente en Vercel, nunca escrita en este código.
//
// Antes de hacer cualquier cosa, esta función verifica que quien está
// llamando (el token que manda panel-accesos.html) es realmente el
// Super Administrador. Si no lo es, rechaza la solicitud.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel' });
  }

  const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Falta autenticación' });

    // Verificar quién hace la llamada
    const { data: userData, error: userError } = await sbAdmin.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Sesión inválida, vuelve a iniciar sesión' });
    }

    const { data: perfilQuienLlama, error: perfilError } = await sbAdmin
      .from('perfiles')
      .select('es_super_admin')
      .eq('id', userData.user.id)
      .single();

    if (perfilError || !perfilQuienLlama || !perfilQuienLlama.es_super_admin) {
      return res.status(403).json({ error: 'Solo el Super Administrador puede hacer esto' });
    }

    const body = req.body || {};
    const accion = body.accion;

    // -------------------------------------------------------
    // Crear un nuevo empleado: crea el usuario de acceso (auth)
    // y su fila en la tabla perfiles.
    // -------------------------------------------------------
    if (accion === 'crear_usuario') {
      const { email, password, nombre, cargo, sede } = body;
      if (!email || !password || !nombre || !cargo || !sede) {
        return res.status(400).json({ error: 'Faltan datos del nuevo empleado' });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }

      const { data: nuevoUsuario, error: createError } = await sbAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createError) {
        return res.status(400).json({ error: 'No se pudo crear el usuario: ' + createError.message });
      }

      const nuevoId = nuevoUsuario.user.id;

      const { error: perfilInsertError } = await sbAdmin.from('perfiles').insert({
        id: nuevoId,
        nombre,
        cargo,
        sede,
        es_super_admin: false,
        activo: true,
      });

      if (perfilInsertError) {
        // Si falla crear el perfil, se deshace la creación del usuario
        // para no dejar un usuario de acceso "huérfano" sin perfil.
        await sbAdmin.auth.admin.deleteUser(nuevoId);
        return res.status(400).json({ error: 'No se pudo crear el perfil: ' + perfilInsertError.message });
      }

      return res.status(200).json({ ok: true, id: nuevoId });
    }

    // -------------------------------------------------------
    // Eliminar un empleado: borra su usuario de acceso (auth).
    // Como perfiles.id y permisos_modulo.perfil_id están configurados
    // con "on delete cascade", su perfil y sus permisos se borran
    // automáticamente al mismo tiempo.
    // -------------------------------------------------------
    if (accion === 'eliminar_usuario') {
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'Falta el id del empleado' });
      if (id === userData.user.id) {
        return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
      }

      const { error: deleteError } = await sbAdmin.auth.admin.deleteUser(id);
      if (deleteError) {
        return res.status(400).json({ error: 'No se pudo eliminar: ' + deleteError.message });
      }
      return res.status(200).json({ ok: true });
    }

    // -------------------------------------------------------
    // Restablecer la contraseña de un empleado existente.
    // -------------------------------------------------------
    if (accion === 'resetear_password') {
      const { id, password } = body;
      if (!id || !password) return res.status(400).json({ error: 'Faltan datos' });
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }

      const { error: updateError } = await sbAdmin.auth.admin.updateUserById(id, { password });
      if (updateError) {
        return res.status(400).json({ error: 'No se pudo cambiar la contraseña: ' + updateError.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
