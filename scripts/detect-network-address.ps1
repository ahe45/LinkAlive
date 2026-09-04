$ErrorActionPreference = 'Stop'

try {
  $routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
    Sort-Object RouteMetric, InterfaceMetric

  foreach ($route in $routes) {
    $address = Get-NetIPAddress `
      -AddressFamily IPv4 `
      -InterfaceIndex $route.InterfaceIndex `
      -ErrorAction SilentlyContinue |
      Where-Object {
        -not $_.SkipAsSource -and
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*'
      } |
      Select-Object -First 1 -ExpandProperty IPAddress

    if ($address) {
      [Console]::Out.Write($address.Trim())
      exit 0
    }
  }
} catch {
  # The batch launcher falls back to localhost when no address is emitted.
}
