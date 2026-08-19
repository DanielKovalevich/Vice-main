const PACKAGE = '@material/material-color-utilities';

export async function resolve(specifier, context, next) {
  const from = context.parentURL ?? '';
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  const bare = !/\.[a-z]+$/i.test(specifier);
  if (relative && bare && from.includes(PACKAGE)) {
    return next(`${specifier}.js`, context);
  }
  return next(specifier, context);
}
