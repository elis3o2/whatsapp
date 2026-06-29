// scripts/validarDni.js
module.exports = {
  async run(vars, numero) {
    console.log("VALIDAR DNI")
    const dni = vars.dni || ''
    const valido = /^\d{7,8}$/.test(dni)
    return {
      next: valido ? 'ok' : 'error',
      vars: {}  // vars adicionales a mergear en el contexto
    }
  }
}