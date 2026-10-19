@echo off
:: Rodar UMA vez como administrador (botao direito -> Executar como administrador).
:: So e necessario se o tablet chamar direto pela rede local (http://IP-DO-PC:8003).
:: Pelo Cloudflare Tunnel nao precisa: o cloudflared so faz conexao de saida.
:: Libera a porta 8003 apenas na rede PRIVADA e apenas para aparelhos da mesma sub-rede local.
:: Confira em Configuracoes -> Rede e Internet que a rede da empresa esta como "Privada".
netsh advfirewall firewall delete rule name="Norvia Etiquetas 8003" >nul 2>&1
netsh advfirewall firewall add rule name="Norvia Etiquetas 8003" dir=in action=allow protocol=TCP localport=8003 profile=private remoteip=localsubnet
pause
