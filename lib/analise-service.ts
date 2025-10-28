import { redisCacheService } from './redis-cache-service';

export interface FiltroAnalise {
  dataInicio: string; // YYYY-MM-DD
  dataFim: string; // YYYY-MM-DD
}

export interface DadosAnalise {
  leads: any[];
  produtosLeads: any[];
  estagiosFunis: any[];
  funis: any[];
  atividades: any[];
  pedidos: any[];
  produtos: any[];
  clientes: any[];
  financeiro: any[];
  filtro: FiltroAnalise;
  timestamp: string;
}

const LOGIN_HEADERS = {
  'token': process.env.SANKHYA_TOKEN || "",
  'appkey': process.env.SANKHYA_APPKEY || "",
  'username': process.env.SANKHYA_USERNAME || "",
  'password': process.env.SANKHYA_PASSWORD || ""
};

const ENDPOINT_LOGIN = "https://api.sandbox.sankhya.com.br/login";
const URL_CONSULTA_SERVICO = "https://api.sandbox.sankhya.com.br/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json";

let cachedToken: string | null = null;

async function obterToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  try {
    const axios = (await import('axios')).default;
    const resposta = await axios.post(ENDPOINT_LOGIN, {}, {
      headers: LOGIN_HEADERS,
      timeout: 10000
    });

    const token = resposta.data.bearerToken || resposta.data.token;
    if (!token) {
      throw new Error("Token não encontrado na resposta de login.");
    }

    cachedToken = token;
    return token;
  } catch (erro: any) {
    cachedToken = null;
    throw new Error(`Falha na autenticação Sankhya: ${erro.message}`);
  }
}

async function fazerRequisicaoAutenticada(fullUrl: string, data: any = {}) {
  const axios = (await import('axios')).default;
  const token = await obterToken();

  try {
    const config = {
      method: 'post',
      url: fullUrl,
      data: data,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };

    const resposta = await axios(config);
    return resposta.data;
  } catch (erro: any) {
    if (erro.response && (erro.response.status === 401 || erro.response.status === 403)) {
      cachedToken = null;
      throw new Error("Sessão expirada. Tente novamente.");
    }
    throw erro;
  }
}

function formatarDataParaSankhya(dataISO: string): string {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function mapearEntidades(entities: any): any[] {
  if (!entities || !entities.entity) {
    return [];
  }

  const fieldNames = entities.metadata.fields.field.map((f: any) => f.name);
  const entityArray = Array.isArray(entities.entity) ? entities.entity : [entities.entity];

  return entityArray.map((rawEntity: any) => {
    const cleanObject: any = {};

    for (let i = 0; i < fieldNames.length; i++) {
      const fieldKey = `f${i}`;
      const fieldName = fieldNames[i];
      if (rawEntity[fieldKey]) {
        cleanObject[fieldName] = rawEntity[fieldKey].$;
      }
    }

    return cleanObject;
  });
}

export async function buscarDadosAnalise(
  filtro: FiltroAnalise,
  userId: number,
  isAdmin: boolean = false
): Promise<DadosAnalise> {

  const cacheKey = `analise:${userId}:${filtro.dataInicio}:${filtro.dataFim}`;

  // Verificar cache primeiro
  const cached = await redisCacheService.get<DadosAnalise>(cacheKey);
  if (cached) {
    console.log('✅ Retornando dados de análise do cache');
    return cached;
  }

  console.log('🔍 Buscando dados de análise da API...');

  const dataInicioSankhya = formatarDataParaSankhya(filtro.dataInicio);
  const dataFimSankhya = formatarDataParaSankhya(filtro.dataFim);

  try {
    // 1. Buscar Leads (filtrado por data de criação)
    let criteriaLeads = `DATA_CRIACAO BETWEEN '${dataInicioSankhya}' AND '${dataFimSankhya}' AND ATIVO = 'S'`;
    if (!isAdmin) {
      criteriaLeads += ` AND CODUSUARIO = ${userId}`;
    }

    const leadsPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_LEADS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODLEAD, NOME, DESCRICAO, VALOR, CODESTAGIO, DATA_VENCIMENTO, TIPO_TAG, COR_TAG, CODPARC, CODFUNIL, CODUSUARIO, ATIVO, DATA_CRIACAO, DATA_ATUALIZACAO, STATUS_LEAD, MOTIVO_PERDA, DATA_CONCLUSAO"
            }
          },
          criteria: {
            expression: { $: criteriaLeads }
          }
        }
      }
    };

    // 2. Buscar Atividades (filtrado por data OU sem data)
    const atividadesPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_ADLEADSATIVIDADES",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODATIVIDADE, CODLEAD, TIPO, DESCRICAO, DATA_HORA, DATA_INICIO, DATA_FIM, CODUSUARIO, DADOS_COMPLEMENTARES, COR, ORDEM, ATIVO, STATUS"
            }
          },
          criteria: {
            expression: {
              $: `ATIVO = 'S' AND (DATA_HORA BETWEEN '${dataInicioSankhya}' AND '${dataFimSankhya}' OR DATA_HORA IS NULL)`
            }
          }
        }
      }
    };

    // 3. Buscar Funis
    const funisPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_FUNIS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODFUNIL, NOME, DESCRICAO, COR, ATIVO, DATA_CRIACAO, DATA_ATUALIZACAO"
            }
          },
          criteria: {
            expression: { $: "ATIVO = 'S'" }
          }
        }
      }
    };

    // 4. Buscar Estágios de Funis
    const estagiosPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_FUNISESTAGIOS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODESTAGIO, CODFUNIL, NOME, ORDEM, COR, ATIVO"
            }
          },
          criteria: {
            expression: { $: "ATIVO = 'S'" }
          }
        }
      }
    };

    // Buscar todos em paralelo (incluindo produtos, clientes e pedidos)
    const [leadsRes, atividadesRes, funisRes, estagiosRes, pedidosRes, produtosRes, clientesRes] = await Promise.all([
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, leadsPayload).catch(err => {
        console.error('❌ Erro ao buscar leads:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, atividadesPayload).catch(err => {
        console.error('❌ Erro ao buscar atividades:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, funisPayload).catch(err => {
        console.error('❌ Erro ao buscar funis:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, estagiosPayload).catch(err => {
        console.error('❌ Erro ao buscar estágios:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, {
        requestBody: {
          dataSet: {
            rootEntity: "CabecalhoNota",
            includePresentationFields: "N",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "NUNOTA, CODPARC, NOMEPARC, DTNEG, VLRNOTA, CODVEND, OBSERVACAO"
              }
            },
            criteria: {
              expression: {
                $: `TIPMOV = 'P' AND DTNEG BETWEEN TO_DATE('${dataInicioSankhya}', 'DD/MM/YYYY') AND TO_DATE('${dataFimSankhya}', 'DD/MM/YYYY')`
              }
            }
          }
        }
      }).catch(err => {
        console.error('❌ Erro ao buscar pedidos:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, {
        requestBody: {
          dataSet: {
            rootEntity: "Produto",
            includePresentationFields: "N",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODPROD, DESCRPROD, ATIVO"
              }
            },
            criteria: {
              expression: { $: "ATIVO = 'S'" }
            }
          }
        }
      }).catch(err => {
        console.error('❌ Erro ao buscar produtos:', err);
        return null;
      }),
      fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, {
        requestBody: {
          dataSet: {
            rootEntity: "Parceiro",
            includePresentationFields: "N",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODPARC, NOMEPARC, CGC_CPF, CLIENTE, ATIVO"
              }
            },
            criteria: {
              expression: { $: "CLIENTE = 'S' AND ATIVO = 'S'" }
            }
          }
        }
      }).catch(err => {
        console.error('❌ Erro ao buscar clientes:', err);
        return null;
      })
    ]);

    console.log('📦 Respostas recebidas:', {
      leads: !!leadsRes?.responseBody?.entities,
      atividades: !!atividadesRes?.responseBody?.entities,
      funis: !!funisRes?.responseBody?.entities,
      estagios: !!estagiosRes?.responseBody?.entities,
      pedidos: !!pedidosRes?.responseBody?.entities,
      produtos: !!produtosRes?.responseBody?.entities,
      clientes: !!clientesRes?.responseBody?.entities
    });

    const leads = leadsRes?.responseBody?.entities ? mapearEntidades(leadsRes.responseBody.entities) : [];
    const atividades = atividadesRes?.responseBody?.entities ? mapearEntidades(atividadesRes.responseBody.entities) : [];
    const funis = funisRes?.responseBody?.entities ? mapearEntidades(funisRes.responseBody.entities) : [];
    const estagiosFunis = estagiosRes?.responseBody?.entities ? mapearEntidades(estagiosRes.responseBody.entities) : [];
    const pedidos = pedidosRes?.responseBody?.entities ? mapearEntidades(pedidosRes.responseBody.entities) : [];
    const produtos = produtosRes?.responseBody?.entities ? mapearEntidades(produtosRes.responseBody.entities) : [];
    const clientes = clientesRes?.responseBody?.entities ? mapearEntidades(clientesRes.responseBody.entities) : [];

    console.log('📊 Dados mapeados:', {
      leads: leads.length,
      atividades: atividades.length,
      funis: funis.length,
      estagios: estagiosFunis.length,
      pedidos: pedidos.length,
      produtos: produtos.length,
      clientes: clientes.length
    });

    // 5. Buscar Produtos dos Leads encontrados
    let produtosLeads: any[] = [];
    if (leads.length > 0) {
      const codLeadsStr = leads.map(l => l.CODLEAD).join(',');
      const produtosLeadsPayload = {
        requestBody: {
          dataSet: {
            rootEntity: "AD_ADLEADSPRODUTOS",
            includePresentationFields: "S",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODITEM, CODLEAD, CODPROD, DESCRPROD, QUANTIDADE, VLRUNIT, VLRTOTAL, ATIVO, DATA_INCLUSAO"
              }
            },
            criteria: {
              expression: { $: `CODLEAD IN (${codLeadsStr}) AND ATIVO = 'S'` }
            }
          }
        }
      };

      const produtosLeadsRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, produtosLeadsPayload);
      produtosLeads = produtosLeadsRes?.responseBody?.entities ? mapearEntidades(produtosLeadsRes.responseBody.entities) : [];
    }

    // 6. Buscar Títulos a Receber (financeiro, filtrado por data de vencimento) - Removido conforme solicitado
    // const financeiroPayload = { ... };
    // const financeiroRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, financeiroPayload).catch(err => { ... });
    // const financeiro = financeiroRes?.responseBody?.entities ? mapearEntidades(financeiroRes.responseBody.entities) : [];

    const resultado: DadosAnalise = {
      leads,
      produtosLeads,
      estagiosFunis,
      funis,
      atividades,
      pedidos,
      produtos,
      clientes,
      financeiro: [], // Financeiro não é mais buscado
      filtro,
      timestamp: new Date().toISOString()
    };

    // Salvar no cache por 30 minutos
    await redisCacheService.set(cacheKey, resultado, 30 * 60);

    console.log('✅ Dados de análise salvos no cache');

    // O bloco de cálculo de métricas foi atualizado para remover o financeiro
    // e ajustar os logs e retornos de acordo.
    console.log(`📊 Dados completos carregados:`, {
      leads: resultado.leads.length,
      atividades: resultado.atividades.length,
      pedidos: resultado.pedidos.length,
      clientes: resultado.clientes.length,
      funis: resultado.funis.length,
      estagios: resultado.estagiosFunis.length
    });

    // Calcular métricas
    const valorTotalPedidos = resultado.pedidos.reduce((sum, p) => sum + (parseFloat(p.VLRNOTA) || 0), 0);

    return {
      leads: resultado.leads,
      produtosLeads: resultado.produtosLeads,
      atividades: resultado.atividades,
      pedidos: resultado.pedidos,
      produtos: [], // Produtos não são mais buscados diretamente para o resumo principal
      clientes: resultado.clientes,
      financeiro: [], // Financeiro não é mais buscado
      funis: resultado.funis,
      estagiosFunis: resultado.estagiosFunis,
      timestamp: new Date().toISOString(),
      filtro,
      // Métricas calculadas
      totalLeads: resultado.leads.length,
      totalAtividades: resultado.atividades.length,
      totalPedidos: resultado.pedidos.length,
      totalProdutos: 0, // Não calculado
      totalClientes: resultado.clientes.length,
      totalFinanceiro: 0, // Não calculado
      valorTotalPedidos,
      valorTotalFinanceiro: 0, // Não calculado
      valorRecebido: 0, // Não calculado
      valorPendente: 0 // Não calculado
    };
  } catch (erro: any) {
    console.error('❌ Erro ao buscar dados de análise:', erro);
    throw erro;
  }
}